import path from 'node:path';
import type {
  ProjectSummary,
  ThreadPickerAction,
  ThreadPickerOptions,
  ThreadSummary,
  ToolProgress,
} from './contracts.js';

const MARKDOWN_IMAGE_REF_RE = /!\[([^\]]*)\]\((\/[^)\s]+)\)/g;
const MARKDOWN_LINK_REF_RE = /\[([^\]]+)\]\((\/[^)\s]+)\)/g;
const ABSOLUTE_PATH_RE = /(^|[\s(])((?:\/Users|\/tmp|\/private\/var\/folders|\/var\/folders)\/[^\s)<>\]]+)/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico)$/i;
const STREAMING_PREVIEW_MAX_CHARS = 7000;
const THREAD_PICKER_MAX_ITEMS = 5;
const THREAD_TITLE_MAX_CHARS = 38;
const THREAD_INLINE_TITLE_MAX_CHARS = 28;
const THREAD_INLINE_TITLE_FONT_SIZE = 18;
const THREAD_INLINE_META_FONT_SIZE = 16;
const THREAD_PATH_SEGMENTS = 3;
const PROJECT_PICKER_MAX_ITEMS = 8;
const PROJECT_TITLE_MAX_CHARS = 28;
const PROJECT_TITLE_FONT_SIZE = 18;
const PROJECT_META_FONT_SIZE = 14;
const PROJECT_PATH_FONT_SIZE = 13;

export function hasComplexMarkdown(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

export function preprocessMarkdown(text: string): string {
  return text.replace(/([^\n])```/g, '$1\n```');
}

export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

export function buildMarkdownCard(text: string, title?: string, template = 'blue'): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: title
      ? {
          template,
          title: { tag: 'plain_text', content: title },
        }
      : undefined,
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

export function buildInfoCard(title: string, body: string, template = 'blue'): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: body || ' ',
        },
      },
    ],
  });
}

function summarizeTools(tools: ToolProgress[]): string {
  if (tools.length === 0) {
    return '';
  }

  const groups = new Map<string, { running: number; complete: number; error: number }>();
  for (const tool of tools) {
    const key = tool.name || 'Tool';
    const entry = groups.get(key) || { running: 0, complete: 0, error: 0 };
    entry[tool.status] += 1;
    groups.set(key, entry);
  }

  const running: string[] = [];
  const complete: string[] = [];
  const failed: string[] = [];
  for (const [name, counts] of groups) {
    if (counts.running > 0) running.push(`${name}${counts.running > 1 ? ` ×${counts.running}` : ''}`);
    if (counts.complete > 0) complete.push(`${name}${counts.complete > 1 ? ` ×${counts.complete}` : ''}`);
    if (counts.error > 0) failed.push(`${name}${counts.error > 1 ? ` ×${counts.error}` : ''}`);
  }

  const lines: string[] = [];
  if (running.length > 0) lines.push(`🔄 运行中: ${running.join(' · ')}`);
  if (complete.length > 0) lines.push(`✅ 已完成: ${complete.join(' · ')}`);
  if (failed.length > 0) lines.push(`❌ 失败: ${failed.join(' · ')}`);
  return lines.join('\n');
}

function compactPreview(text: string, maxChars: number): string {
  const normalized = preprocessMarkdown(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) {
    return 'Thinking';
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const buildNotice = (omittedChars: number) => `...[显示最新内容，已覆盖前文 ${omittedChars} chars]`;
  let visibleBudget = maxChars;
  let visible = '';
  let notice = '';
  for (let i = 0; i < 4; i += 1) {
    visible = normalized.slice(-visibleBudget).trimStart();
    notice = buildNotice(Math.max(0, normalized.length - visible.length));
    const nextVisibleBudget = Math.max(0, maxChars - notice.length - 2);
    if (nextVisibleBudget === visibleBudget) {
      break;
    }
    visibleBudget = nextVisibleBudget;
  }

  return `${notice}\n\n${visible}`;
}

function estimateDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += /[\u0020-\u007e]/.test(char) ? 1 : 2;
  }
  return width;
}

function truncateSingleLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (estimateDisplayWidth(normalized) <= maxChars) return normalized;

  const ellipsis = '…';
  const budget = Math.max(1, maxChars - estimateDisplayWidth(ellipsis));
  let width = 0;
  let visible = '';
  for (const char of normalized) {
    const nextWidth = width + estimateDisplayWidth(char);
    if (nextWidth > budget) break;
    visible += char;
    width = nextWidth;
  }
  return `${visible.trimEnd()}${ellipsis}`;
}

function compactPathLabel(rawPath: string): string {
  const normalized = rawPath.trim();
  if (!normalized || normalized === '~') return normalized || '~';
  const homeRelative = normalized.replace(/^\/Users\/[^/]+\//, '~/');
  if (homeRelative.startsWith('~/')) {
    const parts = homeRelative.slice(2).split('/').filter(Boolean);
    if (parts.length <= 2) {
      return `~/${parts.join('/')}`;
    }
    return `~/…/${parts.slice(-2).join('/')}`;
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return normalized;
  if (parts.length <= THREAD_PATH_SEGMENTS) return normalized;
  return `…/${parts.slice(-THREAD_PATH_SEGMENTS).join('/')}`;
}

function compactThreadScopeLabel(rawPath: string): string {
  const normalized = (path.basename(rawPath) || rawPath).trim();
  if (!normalized) return '';
  if (normalized.length <= 18) return normalized;

  const withoutDatePrefix = normalized.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  if (withoutDatePrefix.length <= 18) {
    return withoutDatePrefix;
  }

  const parts = withoutDatePrefix.split('-').filter(Boolean);
  if (parts.length >= 2) {
    const lastTwo = parts.slice(-2).join('-');
    if (lastTwo.length <= 18) {
      return lastTwo;
    }
  }
  if (parts.length >= 1) {
    const last = parts[parts.length - 1];
    if (last.length <= 18) {
      return last;
    }
  }

  return truncateSingleLine(withoutDatePrefix, 18);
}

function normalizeThreadLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function compactProjectLabel(label: string): string {
  return compactThreadScopeLabel(label);
}

function shouldShowThreadScopeLabel(title: string, scopeLabel: string): boolean {
  if (!scopeLabel) return false;
  const normalizedTitle = normalizeThreadLabel(title);
  const normalizedScope = normalizeThreadLabel(scopeLabel);
  if (!normalizedTitle || !normalizedScope) return true;
  return !normalizedTitle.includes(normalizedScope);
}

export function buildStreamingCard(text: string, tools: ToolProgress[], options?: {
  thinking?: boolean;
  status?: string;
  elapsed?: string;
}): string {
  const sections: string[] = [];
  if (options?.thinking && !text.trim()) {
    sections.push('Thinking');
  } else {
    sections.push(compactPreview(text, STREAMING_PREVIEW_MAX_CHARS));
  }

  const toolSummary = summarizeTools(tools);
  if (toolSummary) {
    sections.push('---', toolSummary);
  }

  if (options?.status || options?.elapsed) {
    const footer = [options.status, options.elapsed].filter(Boolean).join(' · ');
    if (footer) {
      sections.push('---', footer);
    }
  }

  return buildMarkdownCard(sections.filter(Boolean).join('\n'), 'Codex', options?.thinking ? 'wathet' : 'blue');
}

export function buildPermissionCard(body: string, permissionId: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: false },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'Permission Required' },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: body },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Allow' },
            type: 'primary',
            value: { callback_data: `perm:allow:${permissionId}` },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Allow Session' },
            type: 'default',
            value: { callback_data: `perm:allow_session:${permissionId}` },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Deny' },
            type: 'danger',
            value: { callback_data: `perm:deny:${permissionId}` },
          },
        ],
      },
    ],
  });
}

function buildActionElements(actions: ThreadPickerAction[]): Array<Record<string, unknown>> {
  if (actions.length === 0) {
    return [];
  }
  if (actions.length === 2) {
    return [
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: '8px',
        columns: actions.map((action) => ({
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: action.label },
              type: action.style || 'default',
              disabled: action.disabled ?? false,
              value: { callback_data: action.callbackData },
            },
          ],
        })),
      },
    ];
  }
  return [
    {
      tag: 'action',
      actions: actions.map((action) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: action.label },
        type: action.style || 'default',
        disabled: action.disabled ?? false,
        value: { callback_data: action.callbackData },
      })),
    },
  ];
}

function summarizeThreadMeta(
  thread: ThreadSummary,
  currentSessionId: string,
  options?: {
    showWorkdir?: boolean;
    includeProjectLabel?: boolean;
    includeCurrent?: boolean;
  },
): string {
  const bits: string[] = [];
  if ((options?.includeCurrent ?? true) && thread.sessionId === currentSessionId) {
    bits.push('当前');
  }
  if (options?.includeProjectLabel && thread.projectLabel) {
    bits.push(compactProjectLabel(thread.projectLabel));
  } else if (options?.showWorkdir && thread.workingDirectory) {
    const scopeLabel = compactThreadScopeLabel(thread.workingDirectory);
    if (shouldShowThreadScopeLabel(thread.title, scopeLabel)) {
      bits.push(scopeLabel);
    }
  }
  if (thread.lastActiveLabel) {
    bits.push(thread.lastActiveLabel);
  }
  return bits.join(' · ');
}

export function buildThreadPickerCard(
  threads: ThreadSummary[],
  currentSessionId: string,
  options?: ThreadPickerOptions,
): string {
  const startIndex = Math.max(0, Math.trunc(options?.startIndex ?? 0));
  const visibleThreads = threads.slice(
    startIndex,
    startIndex + (options?.maxItems ?? THREAD_PICKER_MAX_ITEMS),
  );
  const actions = options?.actions ?? [
    { label: '项目', callbackData: 'project:list', style: 'default' as const },
    { label: '新线程', callbackData: 'thread:new', style: 'primary' as const },
  ];
  const showWorkdir = !options?.inlineRows
    && new Set(visibleThreads.map((thread) => thread.workingDirectory).filter(Boolean)).size > 1;
  const introText = threads.length === 0
    ? (options?.subtitle || '当前没有可切换的线程。')
    : options?.subtitle;
  const elements: Array<Record<string, unknown>> = [
    ...(introText
      ? [{
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: introText,
          },
        } satisfies Record<string, unknown>]
      : []),
    ...buildActionElements(actions),
  ];

  if (threads.length === 0) {
    return JSON.stringify({
      config: { wide_screen_mode: false },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: options?.title || '最近线程' },
      },
      elements,
    });
  }

  for (const [index, thread] of visibleThreads.entries()) {
    const displayIndex = startIndex + index + 1;
    const title = truncateSingleLine(
      thread.title || `${thread.displayId.slice(0, 8)}...`,
      options?.inlineRows ? THREAD_INLINE_TITLE_MAX_CHARS : THREAD_TITLE_MAX_CHARS,
    );
    const meta = summarizeThreadMeta(thread, currentSessionId, {
      showWorkdir,
      includeProjectLabel: options?.includeProjectLabel,
      includeCurrent: !options?.inlineRows,
    });
    const button = {
      tag: 'button',
      text: { tag: 'plain_text', content: thread.sessionId === currentSessionId ? '当前' : '切换' },
      type: thread.sessionId === currentSessionId ? 'default' : 'primary',
      disabled: thread.sessionId === currentSessionId,
      value: { callback_data: `thread:switch:${thread.displayId}` },
    } as const;

    if (options?.inlineRows) {
      elements.push({
        tag: 'column_set',
        flex_mode: 'stretch',
        horizontal_spacing: '8px',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 7,
            vertical_align: 'top',
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: `**${displayIndex}. ${title}**`,
                  font_size: THREAD_INLINE_TITLE_FONT_SIZE,
                },
              },
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: meta || ' ',
                  font_size: THREAD_INLINE_META_FONT_SIZE,
                },
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'bottom',
            elements: [button],
          },
        ],
      });
    } else {
      elements.push(
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: meta
              ? `**${displayIndex}. ${title}**\n${meta}`
              : `**${displayIndex}. ${title}**`,
          },
        },
        {
          tag: 'action',
          actions: [button],
        },
      );
    }

    if (index < visibleThreads.length - 1) {
      elements.push({ tag: 'hr' });
    }
  }

  if (options?.loadMoreCallbackData && startIndex + visibleThreads.length < threads.length) {
    elements.push(
      { tag: 'hr' },
      ...buildActionElements([
        { label: '查看更多', callbackData: options.loadMoreCallbackData, style: 'default' },
      ]),
    );
  }

  return JSON.stringify({
    config: {
      wide_screen_mode: false,
      update_multi: true,
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: options?.title || '最近线程' },
    },
    elements,
  });
}

export function renderThreadListText(
  threads: ThreadSummary[],
  currentSessionId: string,
  options?: ThreadPickerOptions,
): string {
  if (threads.length === 0) {
    return `${options?.title || '最近线程'}\n\n${options?.subtitle || '当前没有线程。'}`;
  }

  const startIndex = Math.max(0, Math.trunc(options?.startIndex ?? 0));
  const visibleThreads = threads.slice(
    startIndex,
    startIndex + (options?.maxItems ?? THREAD_PICKER_MAX_ITEMS),
  );
  const showWorkdir = new Set(visibleThreads.map((thread) => thread.workingDirectory).filter(Boolean)).size > 1;
  const lines = [options?.title || '最近线程'];
  if (options?.subtitle) {
    lines.push('', options.subtitle);
  }
  for (const [index, thread] of visibleThreads.entries()) {
    const displayIndex = startIndex + index + 1;
    const current = thread.sessionId === currentSessionId ? ' [current]' : '';
    const title = truncateSingleLine(thread.title || `${thread.displayId.slice(0, 8)}...`, THREAD_TITLE_MAX_CHARS);
    lines.push('');
    lines.push(`${displayIndex}. ${title}${current}`);
    const meta = summarizeThreadMeta(thread, currentSessionId, {
      showWorkdir,
      includeProjectLabel: options?.includeProjectLabel,
      includeCurrent: true,
    });
    if (meta) {
      lines.push(meta);
    }
  }
  if (startIndex + visibleThreads.length < threads.length) {
    lines.push('', `本页显示第 ${startIndex + 1}-${startIndex + visibleThreads.length} 条线程。`);
    if (options?.loadMoreCallbackData) {
      lines.push('请在卡片中点击“查看更多”。');
    }
  }
  lines.push('', '切换: 切换线程 2');
  return lines.join('\n');
}

export function buildProjectPickerCard(projects: ProjectSummary[]): string {
  const visibleProjects = projects.slice(0, PROJECT_PICKER_MAX_ITEMS);

  if (projects.length === 0) {
    return buildInfoCard('项目', '当前没有可用项目。');
  }

  const elements: Array<Record<string, unknown>> = [];

  for (const [index, project] of visibleProjects.entries()) {
    const meta = [
      project.kind === 'chat-root' ? '聊天根层' : '',
      project.threadCount > 0 ? `${project.threadCount} 线程` : '暂无线程',
      project.active ? '当前项目' : '',
      project.lastActiveLabel ? `最近 ${project.lastActiveLabel}` : '',
    ].filter(Boolean).join(' · ');
    const projectPath = compactPathLabel(project.pathLabel);

    elements.push(
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${index + 1}. ${truncateSingleLine(project.displayName, PROJECT_TITLE_MAX_CHARS)}**`,
          font_size: PROJECT_TITLE_FONT_SIZE,
        },
      },
      ...(meta
        ? [{
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: meta,
              font_size: PROJECT_META_FONT_SIZE,
            },
          } satisfies Record<string, unknown>]
        : []),
      ...(projectPath
        ? [{
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: projectPath,
              font_size: PROJECT_PATH_FONT_SIZE,
            },
          } satisfies Record<string, unknown>]
        : []),
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: '8px',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '查看线程' },
                type: 'default',
                value: { callback_data: `project:threads:${encodeURIComponent(project.rootPath)}` },
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '在此新建' },
                type: 'primary',
                value: { callback_data: `project:new:${encodeURIComponent(project.rootPath)}` },
              },
            ],
          },
        ],
      },
    );

    if (index < visibleProjects.length - 1) {
      elements.push({ tag: 'hr' });
    }
  }

  return JSON.stringify({
    config: { wide_screen_mode: false },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '项目' },
    },
    elements,
  });
}

export function renderProjectListText(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return '项目\n\n当前没有可用项目。';
  }

  const visibleProjects = projects.slice(0, PROJECT_PICKER_MAX_ITEMS);
  const lines = ['项目', ''];
  for (const [index, project] of visibleProjects.entries()) {
    lines.push(`${index + 1}. ${project.displayName}${project.active ? ' [current]' : ''}`);
    lines.push(compactPathLabel(project.pathLabel));
    lines.push([
      project.kind === 'chat-root' ? '聊天根层' : '',
      project.threadCount > 0 ? `${project.threadCount} 条线程` : '暂无线程',
    ].filter(Boolean).join(' · '));
    if (project.lastActiveLabel) {
      lines.push(`最近 ${project.lastActiveLabel}`);
    }
    lines.push('');
  }
  lines.push('查看项目线程: /project threads 2');
  lines.push('设为当前项目: /project use 2');
  lines.push('在项目下新建: /project new 2');
  return lines.join('\n');
}

export function extractLocalFileReferences(text: string): { text: string; filePaths: string[] } {
  const filePaths = new Set<string>();
  let cleaned = text;

  cleaned = cleaned.replace(MARKDOWN_IMAGE_REF_RE, (_match, alt, filePath) => {
    filePaths.add(filePath);
    return alt ? `![${alt}]` : '';
  });

  cleaned = cleaned.replace(MARKDOWN_LINK_REF_RE, (match, label, filePath) => {
    if (!filePath.startsWith('/')) {
      return match;
    }
    filePaths.add(filePath);
    return label || path.basename(filePath);
  });

  cleaned = cleaned.replace(ABSOLUTE_PATH_RE, (match, prefix, filePath) => {
    filePaths.add(filePath);
    return prefix || '';
  });

  return {
    text: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    filePaths: Array.from(filePaths),
  };
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXT_RE.test(filePath);
}

export function formatElapsed(startedAtMs: number): string {
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const seconds = Math.round(elapsedMs / 100) / 10;
  return `${seconds.toFixed(1)}s`;
}
