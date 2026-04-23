import path from 'node:path';

import type { Config } from '../config.js';
import type { PendingPermissions } from '../permission-gateway.js';
import type { JsonFileStore, ThreadSummary, ThreadToolState } from '../store.js';
import type {
  BridgeAdapter,
  ChannelType,
  ChannelBinding,
  InboundMessage,
  PermissionRequestPayload,
  UiLanguage,
} from './contracts.js';
import { runConversation } from './conversation.js';
import { FeishuAdapter } from './feishu.js';
import { getUiText } from './i18n.js';

const MAX_INPUT_LENGTH = 120_000;
const THREAD_LIST_PAGE_SIZE = 5;
const HAN_CHAR_RE = /\p{Script=Han}/u;
const ENGLISH_WORD_RE = /[A-Za-z]{2,}/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateInlineValue(value: string, maxChars = 120): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function summarizePermissionScopes(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return entryValue.length > 0;
      }
      return Boolean(entryValue);
    })
    .map(([key, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return `${key}(${entryValue.length})`;
      }
      return key;
    });

  if (entries.length === 0) {
    return '';
  }

  const preview = entries.slice(0, 3).join(', ');
  return entries.length > 3 ? `${preview} +${entries.length - 3}` : preview;
}

function renderPermissionRequestBody(
  binding: ChannelBinding,
  payload: PermissionRequestPayload,
  language: UiLanguage,
  options?: { autoAllowed?: boolean },
): string {
  const copy = getUiText(language);
  const lines: string[] = [];
  if (options?.autoAllowed) {
    lines.push(copy.permissionBody.autoAllowed);
  }

  lines.push(`**${copy.permissionBody.tool}：** ${inlineCode(payload.toolName)}`);

  const reason = typeof payload.toolInput.reason === 'string'
    ? truncateInlineValue(payload.toolInput.reason, 100)
    : '';
  if (reason) {
    lines.push(`**${copy.permissionBody.reason}：** ${reason}`);
  }

  if (payload.toolName === 'Bash') {
    const command = typeof payload.toolInput.command === 'string'
      ? truncateInlineValue(payload.toolInput.command, 100)
      : '';
    const cwd = typeof payload.toolInput.cwd === 'string'
      ? truncateInlineValue(payload.toolInput.cwd, 72)
      : '';
    if (command) {
      lines.push(`**${copy.permissionBody.command}：** ${inlineCode(command)}`);
    }
    if (cwd) {
      lines.push(`**${copy.permissionBody.directory}：** ${inlineCode(cwd)}`);
    }
  } else if (payload.toolName === 'Edit') {
    const grantRoot = typeof payload.toolInput.grantRoot === 'string'
      ? truncateInlineValue(payload.toolInput.grantRoot, 72)
      : '';
    if (grantRoot) {
      lines.push(`**${copy.permissionBody.scope}：** ${inlineCode(grantRoot)}`);
    }
  } else if (payload.toolName === 'Permissions') {
    const scopes = summarizePermissionScopes(payload.toolInput.permissions);
    if (scopes) {
      lines.push(`**${copy.permissionBody.permissions}：** ${scopes}`);
    }
  } else {
    const detail = truncateInlineValue(JSON.stringify(payload.toolInput), 100);
    if (detail) {
      lines.push(`**${copy.permissionBody.details}：** ${inlineCode(detail)}`);
    }
  }

  lines.push(`**${copy.permissionBody.thread}：** ${inlineCode(`${binding.codepilotSessionId.slice(0, 8)}...`)}`);
  return lines.join('\n');
}

function truncateInput(text: string): string {
  if (text.length <= MAX_INPUT_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_INPUT_LENGTH);
}

function getDefaultUiLanguage(): UiLanguage {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || '';
  return /^zh(?:[-_]|$)/i.test(locale) ? 'zh-CN' : 'en';
}

function detectUiLanguageFromText(value: string): UiLanguage | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  if (HAN_CHAR_RE.test(normalized)) {
    return 'zh-CN';
  }

  const commandless = normalized.startsWith('/')
    ? normalized.replace(/^\/\S+/, '').trim()
    : normalized;
  if (!commandless) {
    return null;
  }

  const words = commandless.match(ENGLISH_WORD_RE) || [];
  if (words.length === 0) {
    return null;
  }

  const letters = words.join('').length;
  return letters >= 4 ? 'en' : null;
}

function isAbsoluteDir(value: string): boolean {
  return path.isAbsolute(value) && !value.includes('\0') && !value.includes('/../') && !value.endsWith('/..');
}

function validateMode(value: string): value is 'code' | 'plan' | 'ask' {
  return value === 'code' || value === 'plan' || value === 'ask';
}

function looksLikePermissionShortcut(rawText: string): boolean {
  return /^[123]$/.test(normalizeText(rawText));
}

function cleanThreadSwitchTarget(value: string): string {
  return value
    .trim()
    .replace(/^[「『“"']+/, '')
    .replace(/[」』”"']+$/, '')
    .trim();
}

function mapThreadShortcut(rawText: string): string | null {
  const normalized = normalizeText(rawText);
  const listAliases = new Set([
    '线程列表',
    '显示线程',
    '查看线程',
    '列出线程',
    '线程',
  ]);
  if (listAliases.has(normalized)) {
    return '/threads';
  }

  const switchPrefixes = ['切换线程', '切到线程', '切线程', '切换到线程'];
  for (const prefix of switchPrefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const target = cleanThreadSwitchTarget(normalized.slice(prefix.length));
    return target ? `/thread switch ${target}` : '/threads';
  }

  const naturalSwitch = normalized.match(/^切换到(.+)线程$/u);
  if (naturalSwitch?.[1]) {
    const target = cleanThreadSwitchTarget(naturalSwitch[1]);
    return target ? `/thread switch ${target}` : '/threads';
  }

  return null;
}

function encodeProjectRoot(rootPath: string): string {
  return encodeURIComponent(rootPath);
}

function decodeProjectRoot(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
}

function normalizeVisibleThreadCount(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return THREAD_LIST_PAGE_SIZE;
  }
  return Math.max(THREAD_LIST_PAGE_SIZE, Math.trunc(value));
}

function normalizeThreadPageStart(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function parseProjectThreadsCallback(value: string): { projectRoot: string; visibleCount?: number } {
  const lastColon = value.lastIndexOf(':');
  if (lastColon >= 0) {
    const maybeCount = parsePositiveInteger(value.slice(lastColon + 1));
    if (maybeCount) {
      return {
        projectRoot: decodeProjectRoot(value.slice(0, lastColon)),
        visibleCount: maybeCount,
      };
    }
  }

  return { projectRoot: decodeProjectRoot(value) };
}

function parseProjectThreadsPageCallback(value: string): { projectRoot: string; pageStart?: number } {
  const lastColon = value.lastIndexOf(':');
  if (lastColon >= 0) {
    const maybeStart = parsePositiveInteger(value.slice(lastColon + 1));
    if (maybeStart !== null) {
      return {
        projectRoot: decodeProjectRoot(value.slice(0, lastColon)),
        pageStart: maybeStart,
      };
    }
  }

  return { projectRoot: decodeProjectRoot(value) };
}

function permissionResolutionFromAction(action: string): {
  behavior: 'allow' | 'deny';
  updatedPermissions?: unknown[];
} | null {
  if (action === 'allow') {
    return { behavior: 'allow' };
  }
  if (action === 'allow_session') {
    return { behavior: 'allow', updatedPermissions: [{ scope: 'session' }] };
  }
  if (action === 'deny') {
    return { behavior: 'deny' };
  }
  return null;
}

function buildInboundDedupKey(message: InboundMessage): string {
  const base = `${message.address.channelType}:${message.address.chatId}:${message.messageId}`;
  if (message.callbackData) {
    return `${base}:callback:${message.callbackData}`;
  }
  return `${base}:message`;
}

function shouldResetSdkSessionOnError(errorMessage: string): boolean {
  const normalized = normalizeText(errorMessage).toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('resuming session with different model')
    || normalized.includes('no such session')
    || normalized.includes('no such thread')
    || normalized.includes('session not found')
    || normalized.includes('thread not found')
    || normalized.includes('invalid thread')
    || normalized.includes('failed to resume')
    || (normalized.includes('thread/resume') && normalized.includes('not found'))
    || (normalized.includes('resume') && normalized.includes('session'))
  );
}

type ActiveTask = {
  abortController: AbortController;
};

export class FeishuBridgeService {
  private readonly adapter: BridgeAdapter;
  private readonly channelType: ChannelType;
  private readonly sessionChains = new Map<string, Promise<void>>();
  private readonly activeTasks = new Map<string, ActiveTask>();
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly store: JsonFileStore,
    private readonly permissions: PendingPermissions,
    private readonly llm: import('./contracts.js').LLMProvider,
    adapter?: BridgeAdapter,
  ) {
    this.adapter = adapter ?? new FeishuAdapter(config, store);
    this.channelType = this.adapter.channelType;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.adapter.start((message) => this.handleInbound(message));
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const task of this.activeTasks.values()) {
      task.abortController.abort();
    }
    this.activeTasks.clear();
    this.sessionChains.clear();
    await this.adapter.stop();
  }

  isRunning(): boolean {
    return this.running && this.adapter.isRunning();
  }

  getChannelType(): ChannelType {
    return this.channelType;
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    this.store.cleanupExpiredDedup();
    const dedupKey = buildInboundDedupKey(message);
    if (this.store.checkDedup(dedupKey)) {
      return;
    }
    this.store.insertDedup(dedupKey);

    if (message.callbackData) {
      await this.handleCallback(message);
      return;
    }

    const mappedThreadCommand = mapThreadShortcut(message.text);
    if (mappedThreadCommand) {
      await this.handleCommand(message, mappedThreadCommand, message.text);
      return;
    }

    if (message.text.startsWith('/')) {
      await this.handleCommand(message, message.text, message.text);
      return;
    }

    if (looksLikePermissionShortcut(message.text)) {
      const handled = await this.handlePermissionShortcut(message);
      if (handled) return;
    }

    const binding = this.resolveBinding(message.address.chatId);
    this.rememberPreferredLanguage(binding, message.text);
    const chain = this.sessionChains.get(binding.codepilotSessionId) || Promise.resolve();
    const next = chain.then(
      () => this.handleConversationMessage(message, binding),
      () => this.handleConversationMessage(message, binding),
    );
    this.sessionChains.set(binding.codepilotSessionId, next);
    next.finally(() => {
      if (this.sessionChains.get(binding.codepilotSessionId) === next) {
        this.sessionChains.delete(binding.codepilotSessionId);
      }
    }).catch(() => {});
    await next;
  }

  private async handleCallback(message: InboundMessage): Promise<void> {
    const callbackData = message.callbackData || '';
    const binding = this.resolveBinding(message.address.chatId);
    const uiLanguage = this.currentUiLanguage(binding);
    const copy = getUiText(uiLanguage);
    if (callbackData.startsWith('perm:')) {
      const parts = callbackData.split(':');
      const action = parts[1];
      const permissionId = parts.slice(2).join(':');
      const handled = this.resolvePermission(permissionId, action);
      await this.adapter.sendText(
        message.address.chatId,
        handled ? copy.permission.responseRecorded : copy.permission.notFoundOrResolved,
        message.callbackMessageId || message.messageId,
      );
      return;
    }

    if (callbackData.startsWith('thread:switch:')) {
      const identifier = callbackData.slice('thread:switch:'.length);
      await this.switchThread(message, identifier);
      return;
    }

    if (callbackData.startsWith('thread:page:')) {
      const pageStart = parsePositiveInteger(callbackData.slice('thread:page:'.length));
      await this.showThreads(message, binding.codepilotSessionId, pageStart ?? 0);
      return;
    }

    if (callbackData.startsWith('thread:list:')) {
      const visibleCount = parsePositiveInteger(callbackData.slice('thread:list:'.length));
      const pageStart = visibleCount ? Math.max(0, visibleCount - THREAD_LIST_PAGE_SIZE) : 0;
      await this.showThreads(message, binding.codepilotSessionId, pageStart);
      return;
    }

    if (callbackData === 'project:list') {
      await this.showProjects(message);
      return;
    }

    if (callbackData.startsWith('project:threads-page:')) {
      const { projectRoot, pageStart } = parseProjectThreadsPageCallback(
        callbackData.slice('project:threads-page:'.length),
      );
      await this.showProjectThreads(message, projectRoot, pageStart ?? 0);
      return;
    }

    if (callbackData.startsWith('project:threads:')) {
      const { projectRoot, visibleCount } = parseProjectThreadsCallback(
        callbackData.slice('project:threads:'.length),
      );
      const pageStart = visibleCount ? Math.max(0, visibleCount - THREAD_LIST_PAGE_SIZE) : 0;
      await this.showProjectThreads(message, projectRoot, pageStart);
      return;
    }

    if (callbackData.startsWith('project:use:')) {
      const projectRoot = decodeProjectRoot(callbackData.slice('project:use:'.length));
      await this.selectProject(message, projectRoot);
      return;
    }

    if (callbackData.startsWith('project:new:')) {
      const projectRoot = decodeProjectRoot(callbackData.slice('project:new:'.length));
      await this.createAndSwitchThread(message, projectRoot);
      return;
    }

    if (callbackData === 'thread:list') {
      await this.showThreads(message, binding.codepilotSessionId);
      return;
    }

    if (callbackData === 'thread:new') {
      await this.createAndSwitchThread(message, this.resolveNewThreadWorkdir(binding));
      return;
    }
  }

  private async handlePermissionShortcut(message: InboundMessage): Promise<boolean> {
    const binding = this.resolveBinding(message.address.chatId);
    const copy = getUiText(this.currentUiLanguage(binding));
    const pendingLinks = this.store.listPendingPermissionLinksByChat(message.address.chatId);
    if (pendingLinks.length === 0) {
      return false;
    }
    if (pendingLinks.length > 1) {
      await this.adapter.sendText(
        message.address.chatId,
        copy.permission.multiplePending(pendingLinks.length),
        message.messageId,
      );
      return true;
    }

    const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
    const action = actionMap[normalizeText(message.text)];
    const handled = this.resolvePermission(pendingLinks[0].permissionRequestId, action);
    await this.adapter.sendText(
      message.address.chatId,
      handled ? copy.permission.actionRecorded(action) : copy.permission.notFoundOrResolved,
      message.messageId,
    );
    return true;
  }

  private async handleCommand(message: InboundMessage, rawText: string, localeHintText = rawText): Promise<void> {
    const normalized = normalizeText(rawText);
    const [rawCommand, ...rest] = normalized.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const args = rest.join(' ').trim();
    const binding = this.resolveBinding(message.address.chatId);
    const uiLanguage = this.resolveUiLanguage(binding, localeHintText);
    const copy = getUiText(uiLanguage);

    switch (command) {
      case '/start':
      case '/help':
        await this.adapter.sendCommandReply(
          message.address.chatId,
          copy.helpReply(this.adapter.displayName),
          message.messageId,
        );
        return;

      case '/new': {
        const workDir = args && isAbsoluteDir(args)
          ? args
          : this.resolveNewThreadWorkdir(binding);
        await this.createAndSwitchThread(message, workDir);
        return;
      }

      case '/cwd': {
        if (!args || !isAbsoluteDir(args)) {
          await this.adapter.sendText(message.address.chatId, copy.command.cwdUsage, message.messageId);
          return;
        }
        this.store.updateChannelBinding(binding.id, {
          workingDirectory: args,
          preferredWorkingDirectory: args,
        });
        this.store.touchChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId, { workingDirectory: args });
        await this.adapter.sendCommandReply(message.address.chatId, copy.command.cwdSet(escapeHtml(args)), message.messageId);
        return;
      }

      case '/mode': {
        if (!validateMode(args)) {
          await this.adapter.sendText(message.address.chatId, copy.command.modeUsage, message.messageId);
          return;
        }
        this.store.updateChannelBinding(binding.id, { mode: args });
        await this.adapter.sendCommandReply(message.address.chatId, copy.command.modeSet(args), message.messageId);
        return;
      }

      case '/status': {
        const summary = this.store.describeChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId);
        const busy = this.store.getBusyLocalThreadState(binding.codepilotSessionId);
        const lines = [
          `<b>${copy.command.statusTitle(this.adapter.displayName)}</b>`,
          '',
          `${copy.command.session}: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
          `${copy.command.cwd}: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
          `${copy.command.mode}: <b>${binding.mode}</b>`,
          `${copy.command.model}: <code>${escapeHtml(binding.model || 'default')}</code>`,
        ];
        if (summary?.latestUserPreview) {
          lines.push(`${copy.command.recent}: ${escapeHtml(summary.latestUserPreview)}`);
        }
        if (binding.preferredWorkingDirectory && binding.preferredWorkingDirectory !== binding.workingDirectory) {
          lines.push(`${copy.command.project}: <code>${escapeHtml(binding.preferredWorkingDirectory)}</code>`);
        }
        if (busy) {
          lines.push(`${copy.command.busy}: <b>${copy.command.desktopThreadActive}</b>`);
        }
        await this.adapter.sendCommandReply(message.address.chatId, lines.join('\n'), message.messageId);
        return;
      }

      case '/threads':
        await this.showThreads(message, binding.codepilotSessionId);
        return;

      case '/projects':
        await this.showProjects(message);
        return;

      case '/thread':
        if (!args) {
          await this.adapter.sendText(message.address.chatId, copy.command.threadUsage, message.messageId);
          return;
        }
        if (args === 'list') {
          await this.showThreads(message, binding.codepilotSessionId);
          return;
        }
        if (args.startsWith('switch ')) {
          await this.switchThread(message, args.slice('switch '.length).trim());
          return;
        }
        if (args === 'new') {
          await this.createAndSwitchThread(message, this.resolveNewThreadWorkdir(binding));
          return;
        }
        await this.adapter.sendText(message.address.chatId, copy.command.threadUsage, message.messageId);
        return;

      case '/project':
        if (!args || args === 'list') {
          await this.showProjects(message);
          return;
        }
        if (args.startsWith('use ')) {
          await this.selectProject(message, args.slice('use '.length).trim());
          return;
        }
        if (args.startsWith('threads ')) {
          await this.showProjectThreads(message, args.slice('threads '.length).trim());
          return;
        }
        if (args.startsWith('new ')) {
          const project = this.store.findCodexProject(args.slice('new '.length).trim());
          if (!project) {
            await this.adapter.sendText(message.address.chatId, copy.command.projectNotFound, message.messageId);
            return;
          }
          await this.createAndSwitchThread(message, project.rootPath);
          return;
        }
        await this.adapter.sendText(message.address.chatId, copy.command.projectUsage, message.messageId);
        return;

      case '/stop': {
        const active = this.activeTasks.get(binding.codepilotSessionId);
        if (!active) {
          await this.adapter.sendText(message.address.chatId, copy.command.noTaskRunning, message.messageId);
          return;
        }
        active.abortController.abort();
        this.activeTasks.delete(binding.codepilotSessionId);
        await this.adapter.sendText(message.address.chatId, copy.command.stoppingTask, message.messageId);
        return;
      }

      case '/perm': {
        const [action, permissionId] = args.split(/\s+/, 2);
        if (!action || !permissionId) {
          await this.adapter.sendText(message.address.chatId, copy.command.permUsage, message.messageId);
          return;
        }
        const handled = this.resolvePermission(permissionId, action);
        await this.adapter.sendText(
          message.address.chatId,
          handled ? copy.command.permRecorded(action) : copy.permission.notFoundOrResolved,
          message.messageId,
        );
        return;
      }

      case '/permtest':
        await this.runPermissionTest(message, binding);
        return;

      default:
        await this.adapter.sendText(message.address.chatId, copy.command.unknownCommand(command), message.messageId);
    }
  }

  private async deliverThreadPicker(
    message: InboundMessage,
    threads: ThreadSummary[],
    currentSessionId: string,
    options: {
      title: string;
      subtitle?: string;
      maxItems?: number;
      inlineRows?: boolean;
      includeProjectLabel?: boolean;
      actions?: Array<{ label: string; callbackData: string; style?: 'default' | 'primary' | 'danger'; disabled?: boolean }>;
      loadMoreCallbackData?: string;
    },
    replaceExisting = false,
  ): Promise<void> {
    if (replaceExisting && message.callbackMessageId && this.adapter.updateThreadPicker) {
      const updated = await this.adapter.updateThreadPicker(
        message.address.chatId,
        message.callbackMessageId,
        threads,
        currentSessionId,
        options,
      );
      if (updated) {
        return;
      }
    }

    await this.adapter.sendThreadPicker(
      message.address.chatId,
      threads,
      currentSessionId,
      message.callbackMessageId || message.messageId,
      options,
    );
  }

  private async showThreads(
    message: InboundMessage,
    currentSessionId: string,
    pageStart = 0,
    replaceExisting = false,
  ): Promise<void> {
    const binding = this.resolveBinding(message.address.chatId);
    const uiLanguage = this.currentUiLanguage(binding);
    const copy = getUiText(uiLanguage);
    const threads = this.store.listChatThreads(this.channelType, message.address.chatId);
    const normalizedPageStart = normalizeThreadPageStart(pageStart);
    const nextPageStart = normalizedPageStart + THREAD_LIST_PAGE_SIZE < threads.length
      ? normalizedPageStart + THREAD_LIST_PAGE_SIZE
      : null;

    await this.deliverThreadPicker(
      message,
      threads,
      currentSessionId,
      {
        title: copy.threadPicker.title,
        startIndex: normalizedPageStart,
        maxItems: THREAD_LIST_PAGE_SIZE,
        inlineRows: true,
        includeProjectLabel: true,
        language: uiLanguage,
        loadMoreCallbackData: nextPageStart !== null ? `thread:page:${nextPageStart}` : undefined,
      },
      replaceExisting,
    );
  }

  private async showProjects(message: InboundMessage): Promise<void> {
    const binding = this.resolveBinding(message.address.chatId);
    const uiLanguage = this.currentUiLanguage(binding);
    const projects = this.store.listCodexProjects();
    await this.adapter.sendProjectPicker(message.address.chatId, projects, message.messageId, uiLanguage);
  }

  private async showProjectThreads(
    message: InboundMessage,
    identifier: string,
    pageStart = 0,
    replaceExisting = false,
  ): Promise<void> {
    const binding = this.resolveBinding(message.address.chatId);
    const uiLanguage = this.currentUiLanguage(binding);
    const copy = getUiText(uiLanguage);
    const project = this.store.findCodexProject(identifier);
    if (!project) {
      await this.adapter.sendText(message.address.chatId, copy.command.projectNotFound, message.messageId);
      return;
    }

    const threads = this.store.listProjectThreads(this.channelType, message.address.chatId, project.rootPath);
    const normalizedPageStart = normalizeThreadPageStart(pageStart);
    const nextPageStart = normalizedPageStart + THREAD_LIST_PAGE_SIZE < threads.length
      ? normalizedPageStart + THREAD_LIST_PAGE_SIZE
      : null;

    await this.deliverThreadPicker(
      message,
      threads,
      binding.codepilotSessionId,
      {
        title: copy.projectPicker.projectThreadsTitle(project.displayName),
        subtitle: copy.projectPicker.projectSubtitle(project.displayName),
        startIndex: normalizedPageStart,
        maxItems: THREAD_LIST_PAGE_SIZE,
        inlineRows: true,
        language: uiLanguage,
        actions: [
          { label: copy.projectPicker.projectList, callbackData: 'project:list', style: 'default' },
          {
            label: binding.preferredWorkingDirectory === project.rootPath
              ? copy.projectPicker.currentProject
              : copy.projectPicker.useProject,
            callbackData: `project:use:${encodeProjectRoot(project.rootPath)}`,
            style: 'default',
            disabled: binding.preferredWorkingDirectory === project.rootPath,
          },
          { label: copy.projectPicker.createHere, callbackData: `project:new:${encodeProjectRoot(project.rootPath)}`, style: 'primary' },
        ],
        loadMoreCallbackData: nextPageStart !== null
          ? `project:threads-page:${encodeProjectRoot(project.rootPath)}:${nextPageStart}`
          : undefined,
      },
      replaceExisting,
    );
  }

  private async selectProject(message: InboundMessage, identifier: string): Promise<void> {
    const project = this.store.findCodexProject(identifier);
    const binding = this.resolveBinding(message.address.chatId);
    const copy = getUiText(this.currentUiLanguage(binding));
    if (!project) {
      await this.adapter.sendText(message.address.chatId, copy.command.projectNotFound, message.messageId);
      return;
    }

    this.store.updateChannelBinding(binding.id, {
      preferredWorkingDirectory: project.rootPath,
    });
    await this.adapter.sendCommandReply(
      message.address.chatId,
      copy.command.switchedCurrentProject(escapeHtml(project.displayName)),
      message.messageId,
    );
  }

  private async createAndSwitchThread(message: InboundMessage, workDir?: string): Promise<void> {
    const binding = this.resolveBinding(message.address.chatId);
    const copy = getUiText(this.currentUiLanguage(binding));
    const newBinding = this.createBinding(message.address.chatId, workDir);
    const summary = this.store.describeChatThread(this.channelType, message.address.chatId, newBinding.codepilotSessionId);
    const title = summary?.title || copy.command.newThreadDefaultTitle;
    const projectLabel = summary?.projectLabel || copy.command.chatLabel;
    await this.adapter.sendCommandReply(
      message.address.chatId,
      copy.command.newThread(escapeHtml(title), escapeHtml(projectLabel)),
      message.messageId,
    );
  }

  private async switchThread(message: InboundMessage, identifier: string): Promise<void> {
    const currentBinding = this.resolveBinding(message.address.chatId);
    const copy = getUiText(this.currentUiLanguage(currentBinding));
    const target = this.store.findChatThread(this.channelType, message.address.chatId, identifier);
    if (!target) {
      await this.adapter.sendText(message.address.chatId, copy.command.threadNotFound, message.messageId);
      return;
    }

    const resolved = target.importable
      ? this.store.importChatThread(this.channelType, message.address.chatId, target.sdkSessionId)
      : target;

    if (!resolved) {
      await this.adapter.sendText(message.address.chatId, copy.command.importThreadFailed, message.messageId);
      return;
    }

    this.store.updateChannelBinding(currentBinding.id, {
      codepilotSessionId: resolved.sessionId,
      sdkSessionId: resolved.sdkSessionId,
      workingDirectory: resolved.workingDirectory,
      preferredWorkingDirectory: resolved.workingDirectory,
      model: resolved.model,
      updatedAt: new Date().toISOString(),
    });
    this.store.touchChatThread(this.channelType, message.address.chatId, resolved.sessionId, {
      workingDirectory: resolved.workingDirectory,
      model: resolved.model,
      title: resolved.title,
      touch: false,
    });

    await this.adapter.sendCommandReply(
      message.address.chatId,
      copy.command.switchedThread(escapeHtml(resolved.title), escapeHtml(resolved.projectLabel || copy.command.chatLabel)),
      message.messageId,
    );

    const mirrored = await this.maybeMirrorBusyThread(message, this.resolveBinding(message.address.chatId));
    if (mirrored) {
      return;
    }
  }

  private resolveUiLanguage(binding: ChannelBinding, inputText: string): UiLanguage {
    const detected = this.rememberPreferredLanguage(binding, inputText);
    if (detected) {
      return detected;
    }

    return this.currentUiLanguage(binding);
  }

  private currentUiLanguage(binding: ChannelBinding): UiLanguage {
    const recentLanguage = this.detectRecentUiLanguage(binding);
    if (recentLanguage) {
      return recentLanguage;
    }
    return binding.preferredLanguage || getDefaultUiLanguage();
  }

  private detectRecentUiLanguage(binding: ChannelBinding): UiLanguage | null {
    const recentMessages = this.store.getMessages(binding.codepilotSessionId, { limit: 20 }).messages;
    for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
      const message = recentMessages[index];
      if (message.role !== 'user') {
        continue;
      }
      const recentLanguage = detectUiLanguageFromText(message.content);
      if (!recentLanguage) {
        continue;
      }
      if (binding.preferredLanguage !== recentLanguage) {
        this.store.updateChannelBinding(binding.id, { preferredLanguage: recentLanguage });
      }
      return recentLanguage;
    }
    return null;
  }

  private rememberPreferredLanguage(binding: ChannelBinding, inputText: string): UiLanguage | null {
    const detected = detectUiLanguageFromText(inputText);
    if (!detected || binding.preferredLanguage === detected) {
      return detected;
    }
    this.store.updateChannelBinding(binding.id, { preferredLanguage: detected });
    return detected;
  }

  private async runPermissionTest(message: InboundMessage, binding: ChannelBinding): Promise<void> {
    await this.handleConversationMessage(message, binding, {
      promptOverride: 'Run a harmless shell command that requires approval: create and then remove ~/.codex-feishu/.permtest-smoke . Do not do anything else.',
      uiLanguage: this.currentUiLanguage(binding),
    });
  }

  private async handleConversationMessage(
    message: InboundMessage,
    binding: ChannelBinding,
    options?: { promptOverride?: string; uiLanguage?: UiLanguage },
  ): Promise<void> {
    const mirrored = await this.maybeMirrorBusyThread(message, binding);
    if (mirrored) return;

    const promptSource = options?.promptOverride ?? message.text;
    const prompt = truncateInput(promptSource || (message.attachments?.length ? 'Describe this attachment.' : ''));
    if (!prompt && !message.attachments?.length) {
      return;
    }

    const uiLanguage = options?.uiLanguage || this.resolveUiLanguage(binding, message.text);
    const copy = getUiText(uiLanguage);

    this.adapter.beginResponse(message.address.chatId, message.messageId, uiLanguage);
    const abortController = new AbortController();
    let inboundAbortListener: (() => void) | null = null;
    if (message.abortSignal) {
      inboundAbortListener = () => abortController.abort();
      if (message.abortSignal.aborted) {
        abortController.abort();
      } else {
        message.abortSignal.addEventListener('abort', inboundAbortListener, { once: true });
      }
    }
    this.activeTasks.set(binding.codepilotSessionId, { abortController });
    let partialText = '';
    let tools: ThreadToolState[] = [];

    try {
      const result = await runConversation(this.store, this.llm, binding, prompt, {
        abortSignal: abortController.signal,
        files: message.attachments,
        callbacks: {
          onPartialText: (fullText) => {
            partialText = fullText;
            this.adapter.updateResponse(message.address.chatId, fullText, tools);
          },
          onTools: (nextTools) => {
            tools = nextTools;
            this.adapter.updateResponse(message.address.chatId, partialText, tools);
          },
          onPermission: async (payload) => {
            await this.forwardPermissionRequest(message, binding, payload, uiLanguage);
          },
        },
      });

      if (binding.id) {
        const nextSdkSessionId = result.sdkSessionId || binding.sdkSessionId;
        if (nextSdkSessionId && !shouldResetSdkSessionOnError(result.errorMessage)) {
          this.store.updateChannelBinding(binding.id, { sdkSessionId: nextSdkSessionId });
        } else if (result.hasError && shouldResetSdkSessionOnError(result.errorMessage)) {
          this.store.updateChannelBinding(binding.id, { sdkSessionId: '' });
        }
      }
      this.store.touchChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId, {
        workingDirectory: binding.workingDirectory,
        model: binding.model,
      });
      this.store.syncBridgeThreadFromLocal(binding.codepilotSessionId);

      if (result.responseText) {
        await this.adapter.finalizeResponse(message.address.chatId, 'completed', result.responseText, message.messageId);
      } else if (result.hasError) {
        await this.adapter.finalizeResponse(
          message.address.chatId,
          'error',
          `${copy.command.errorTitle}\n\n${result.errorMessage}`,
          message.messageId,
        );
      } else {
        await this.adapter.finalizeResponse(message.address.chatId, 'completed', copy.command.done, message.messageId);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const status = abortController.signal.aborted ? 'interrupted' : 'error';
      await this.adapter.finalizeResponse(message.address.chatId, status, messageText, message.messageId);
    } finally {
      if (message.abortSignal && inboundAbortListener) {
        message.abortSignal.removeEventListener('abort', inboundAbortListener);
      }
      this.activeTasks.delete(binding.codepilotSessionId);
    }
  }

  private async maybeMirrorBusyThread(message: InboundMessage, binding: ChannelBinding): Promise<boolean> {
    const uiLanguage = this.resolveUiLanguage(binding, message.text);
    const copy = getUiText(uiLanguage);
    const busyThread = this.store.getBusyLocalThreadState(binding.codepilotSessionId);
    if (!busyThread) {
      return false;
    }

    await this.adapter.sendText(message.address.chatId, copy.command.currentThreadBusy, message.messageId);
    this.adapter.beginResponse(message.address.chatId, message.messageId, uiLanguage);

    const abortController = new AbortController();
    let inboundAbortListener: (() => void) | null = null;
    if (message.abortSignal) {
      inboundAbortListener = () => abortController.abort();
      if (message.abortSignal.aborted) {
        abortController.abort();
      } else {
        message.abortSignal.addEventListener('abort', inboundAbortListener, { once: true });
      }
    }
    this.activeTasks.set(binding.codepilotSessionId, { abortController });
    let streamedText = busyThread.previewText || '';
    let finalText = busyThread.finalText || streamedText;
    let tools: ThreadToolState[] = busyThread.tools;
    this.adapter.updateResponse(message.address.chatId, streamedText, tools);

    try {
      const result = await this.store.followBusyLocalThread(binding.codepilotSessionId, {
        abortSignal: abortController.signal,
        onText: (fullText) => {
          streamedText = fullText;
          this.adapter.updateResponse(message.address.chatId, streamedText, tools);
        },
        onTools: (nextTools) => {
          tools = nextTools;
          this.adapter.updateResponse(message.address.chatId, streamedText, tools);
        },
      });

      if (result.finalText) {
        finalText = result.finalText;
      }

      if (result.completed) {
        const synced = this.store.syncImportedThreadFromLocalSource(binding.codepilotSessionId);
        if (!finalText) {
          finalText = synced?.assistantText || synced?.userText || '';
        }
      }

      await this.adapter.finalizeResponse(
        message.address.chatId,
        result.completed ? 'completed' : 'interrupted',
        finalText || streamedText,
        message.messageId,
      );
    } catch (error) {
      await this.adapter.finalizeResponse(
        message.address.chatId,
        abortController.signal.aborted ? 'interrupted' : 'error',
        finalText || streamedText || (error instanceof Error ? error.message : String(error)),
        message.messageId,
      );
    } finally {
      if (message.abortSignal && inboundAbortListener) {
        message.abortSignal.removeEventListener('abort', inboundAbortListener);
      }
      this.activeTasks.delete(binding.codepilotSessionId);
    }

    return true;
  }

  private async forwardPermissionRequest(
    message: InboundMessage,
    binding: ChannelBinding,
    payload: PermissionRequestPayload,
    uiLanguage: UiLanguage,
  ): Promise<void> {
    if (this.channelType === 'rokid' && this.config.rokidAutoAllowPermissions) {
      const resolution: { behavior: 'allow'; updatedPermissions: unknown[] } = {
        behavior: 'allow',
        updatedPermissions: [{ scope: 'session' }],
      };
      if (!this.permissions.resolve(payload.permissionRequestId, resolution)) {
        setTimeout(() => {
          this.permissions.resolve(payload.permissionRequestId, resolution);
        }, 0);
      }
      const body = renderPermissionRequestBody(binding, payload, uiLanguage, { autoAllowed: true });
      await this.adapter.sendPermissionRequest(
        message.address.chatId,
        body,
        payload.permissionRequestId,
        message.messageId,
        uiLanguage,
      );
      return;
    }

    this.store.insertPermissionLink({
      permissionRequestId: payload.permissionRequestId,
      channelType: this.channelType,
      chatId: message.address.chatId,
      messageId: message.messageId,
      toolName: payload.toolName,
      suggestions: JSON.stringify(payload.suggestions || []),
    });

    const body = renderPermissionRequestBody(binding, payload, uiLanguage);

    await this.adapter.sendPermissionRequest(
      message.address.chatId,
      body,
      payload.permissionRequestId,
      message.messageId,
      uiLanguage,
    );
  }

  private resolvePermission(permissionId: string, action: string): boolean {
    const resolution = permissionResolutionFromAction(action);
    if (!resolution) return false;
    const claimed = this.store.markPermissionLinkResolved(permissionId);
    if (!claimed) return false;
    return this.permissions.resolve(permissionId, resolution);
  }

  private resolveBinding(chatId: string): ChannelBinding {
    const existing = this.store.getChannelBinding(this.channelType, chatId);
    if (existing) {
      const session = this.store.getSession(existing.codepilotSessionId);
      if (session) return existing;
    }
    return this.createBinding(chatId, this.resolveDefaultWorkdir());
  }

  private resolveDefaultWorkdir(): string {
    return this.store.getDefaultChatRoot() || this.config.defaultWorkDir;
  }

  private resolveNewThreadWorkdir(binding: ChannelBinding): string {
    return binding.preferredWorkingDirectory
      || binding.workingDirectory
      || this.resolveDefaultWorkdir();
  }

  private createBinding(chatId: string, workDir?: string): ChannelBinding {
    const workingDirectory = workDir || this.resolveDefaultWorkdir();
    const model = this.config.defaultModel || '';
    const session = this.store.createSession(
      `${this.adapter.displayName} ${chatId}`,
      model,
      undefined,
      workingDirectory,
      this.config.defaultMode,
    );
    const defaultProviderId = this.store.getDefaultProviderId();
    if (defaultProviderId) {
      this.store.updateSessionProviderId(session.id, defaultProviderId);
    }
    const binding = this.store.upsertChannelBinding({
      channelType: this.channelType,
      chatId,
      codepilotSessionId: session.id,
      workingDirectory: session.working_directory,
      preferredWorkingDirectory: session.working_directory,
      model: session.model,
    });
    const initialTitle = session.working_directory === this.store.getDefaultChatRoot()
      ? '新线程'
      : (path.basename(session.working_directory) || '新线程');
    this.store.touchChatThread(this.channelType, chatId, binding.codepilotSessionId, {
      workingDirectory: session.working_directory,
      model: session.model,
      title: initialTitle,
      touch: false,
    });
    return binding;
  }
}
