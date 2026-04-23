import type { UiLanguage } from './contracts.js';

function isZh(language: UiLanguage): boolean {
  return language === 'zh-CN';
}

function permissionActionLabel(language: UiLanguage, action: string): string {
  if (isZh(language)) {
    if (action === 'allow') return '允许';
    if (action === 'allow_session') return '允许本会话';
    return '拒绝';
  }
  if (action === 'allow') return 'Allow';
  if (action === 'allow_session') return 'Allow Session';
  return 'Deny';
}

export function getUiText(language: UiLanguage) {
  const zh = isZh(language);

  return {
    helpReply(displayName: string): string {
      if (zh) {
        return [
          `<b>Codex ${displayName}</b>`,
          '',
          '/new [path] - 新建线程',
          '/cwd /abs/path - 切换工作目录',
          '/mode code|plan|ask - 切换模式',
          '/status - 查看当前线程',
          '/threads - 查看最近线程',
          '/projects - 查看 Codex 项目',
          '/project list | use [id] | threads [id] | new [id] - 项目命令',
          '/thread switch [id|index] - 切换线程',
          '/stop - 停止当前任务',
          '/perm allow|allow_session|deny [id] - 处理权限请求',
          '/permtest - 触发一个审批测试',
        ].join('\n');
      }

      return [
        `<b>Codex ${displayName}</b>`,
        '',
        '/new [path] - Start a new thread',
        '/cwd /abs/path - Change working directory',
        '/mode code|plan|ask - Change mode',
        '/status - Show current thread',
        '/threads - Show recent threads',
        '/projects - Show Codex projects',
        '/project list | use [id] | threads [id] | new [id] - Project commands',
        '/thread switch [id|index] - Switch thread',
        '/stop - Stop current task',
        '/perm allow|allow_session|deny [id] - Resolve permission',
        '/permtest - Trigger an approval test',
      ].join('\n');
    },

    permissionActionLabel(action: string): string {
      return permissionActionLabel(language, action);
    },

    permission: {
      title: zh ? '需要审批' : 'Permission Required',
      allow: zh ? '允许' : 'Allow',
      allowSession: zh ? '允许本会话' : 'Allow Session',
      deny: zh ? '拒绝' : 'Deny',
      responseRecorded: zh ? '已记录审批结果。' : 'Permission response recorded.',
      notFoundOrResolved: zh ? '未找到权限请求，或已处理。' : 'Permission not found or already resolved.',
      multiplePending(count: number): string {
        return zh
          ? `当前有 ${count} 个待处理审批，请使用 /perm allow|allow_session|deny [id]。`
          : `Multiple pending permissions (${count}). Please use /perm allow|allow_session|deny [id].`;
      },
      actionRecorded(action: string): string {
        return zh
          ? `${permissionActionLabel(language, action)}：已记录。`
          : `${permissionActionLabel(language, action)}: recorded.`;
      },
      fallback(permissionId: string): string {
        return zh
          ? `回复：\n1 - 允许\n2 - 允许本会话\n3 - 拒绝\n\n或者使用 /perm allow|allow_session|deny ${permissionId}`
          : `Reply:\n1 - Allow\n2 - Allow Session\n3 - Deny\n\nOr use /perm allow|allow_session|deny ${permissionId}`;
      },
      continueInDesktopOrFeishu: zh
        ? '需要在 Codex 桌面端或 Feishu 审批后继续。'
        : 'Approval is required in Codex Desktop or Feishu before continuing.',
    },

    permissionBody: {
      autoAllowed: zh ? 'Rokid 通道已自动允许。' : 'Auto-allowed for the Rokid channel.',
      tool: zh ? '工具' : 'Tool',
      reason: zh ? '说明' : 'Reason',
      command: zh ? '命令' : 'Command',
      directory: zh ? '目录' : 'Directory',
      scope: zh ? '范围' : 'Scope',
      permissions: zh ? '权限' : 'Permissions',
      details: zh ? '详情' : 'Details',
      thread: zh ? '线程' : 'Thread',
    },

    command: {
      cwdUsage: zh ? '用法：/cwd /absolute/path' : 'Usage: /cwd /absolute/path',
      cwdSet(pathValue: string): string {
        return zh
          ? `工作目录已切换到 <code>${pathValue}</code>`
          : `Working directory set to <code>${pathValue}</code>`;
      },
      modeUsage: zh ? '用法：/mode code|plan|ask' : 'Usage: /mode code|plan|ask',
      modeSet(mode: string): string {
        return zh ? `模式已切换为 <b>${mode}</b>` : `Mode set to <b>${mode}</b>`;
      },
      statusTitle(displayName: string): string {
        return zh ? `Codex ${displayName} 状态` : `Codex ${displayName} Status`;
      },
      session: zh ? '会话' : 'Session',
      cwd: zh ? '目录' : 'CWD',
      mode: zh ? '模式' : 'Mode',
      model: zh ? '模型' : 'Model',
      recent: zh ? '最近' : 'Recent',
      project: zh ? '项目' : 'Project',
      busy: zh ? '忙碌' : 'Busy',
      desktopThreadActive: zh ? '桌面线程运行中' : 'desktop thread active',
      threadUsage: zh
        ? '用法：/thread list | /thread switch [index|id]'
        : 'Usage: /thread list | /thread switch [index|id]',
      projectNotFound: zh ? '未找到对应项目。' : 'Project not found.',
      projectUsage: zh
        ? '用法：/project list | /project use [index|name] | /project threads [index|name] | /project new [index|name]'
        : 'Usage: /project list | /project use [index|name] | /project threads [index|name] | /project new [index|name]',
      noTaskRunning: zh ? '当前没有正在运行的任务。' : 'No task is currently running.',
      stoppingTask: zh ? '正在停止当前任务...' : 'Stopping current task...',
      permUsage: zh
        ? '用法：/perm allow|allow_session|deny [id]'
        : 'Usage: /perm allow|allow_session|deny [id]',
      permRecorded(action: string): string {
        return zh
          ? `权限处理结果：${permissionActionLabel(language, action)}`
          : `Permission ${action}: recorded.`;
      },
      unknownCommand(command: string): string {
        return zh ? `未知命令：${command}` : `Unknown command: ${command}`;
      },
      switchedCurrentProject(projectName: string): string {
        return zh
          ? `<b>已切换当前项目</b>\n\n<b>${projectName}</b>\n\n后续 <code>/new</code> 会默认在这个项目下创建线程。`
          : `<b>Current project updated</b>\n\n<b>${projectName}</b>\n\nFuture <code>/new</code> commands will create threads in this project by default.`;
      },
      newThread(title: string, projectLabel: string): string {
        return zh
          ? `<b>已新建线程</b>\n\n<b>${title}</b>\n项目：${projectLabel}`
          : `<b>New thread created</b>\n\n<b>${title}</b>\nProject: ${projectLabel}`;
      },
      newThreadDefaultTitle: zh ? '新线程' : 'New thread',
      chatLabel: zh ? '聊天' : 'Chat',
      threadNotFound: zh ? '未找到对应线程。' : 'Thread not found.',
      importThreadFailed: zh ? '导入线程失败。' : 'Failed to import thread.',
      switchedThread(title: string, projectLabel: string): string {
        return zh
          ? `<b>已切换线程</b>\n\n<b>${title}</b>\n项目：${projectLabel}`
          : `<b>Thread switched</b>\n\n<b>${title}</b>\nProject: ${projectLabel}`;
      },
      currentThreadBusy: zh ? '当前线程忙碌中' : 'Current thread is busy.',
      errorTitle: zh ? '错误' : 'Error',
      done: zh ? '已完成。' : 'Done.',
    },

    streaming: {
      emptyThinking: zh ? '思考中' : 'Thinking',
      truncatedNotice(omittedChars: number): string {
        return zh
          ? `...[显示最新内容，已覆盖前文 ${omittedChars} chars]`
          : `...[showing latest content, ${omittedChars} chars omitted]`;
      },
      running: zh ? '🔄 进行中' : '🔄 Running',
      complete: zh ? '✅ 已完成' : '✅ Completed',
      failed: zh ? '❌ 失败' : '❌ Failed',
      statusCompleted: zh ? '✅ 已完成' : '✅ Completed',
      statusError: zh ? '❌ 错误' : '❌ Error',
      statusInterrupted: zh ? '⚠️ 已中断' : '⚠️ Interrupted',
    },

    threadPicker: {
      projects: zh ? '项目' : 'Projects',
      newThread: zh ? '新线程' : 'New Thread',
      emptySwitchable: zh ? '当前没有可切换的线程。' : 'No switchable threads yet.',
      title: zh ? '最近线程' : 'Recent Threads',
      current: zh ? '当前' : 'Current',
      switch: zh ? '切换' : 'Switch',
      loadMore: zh ? '查看更多' : 'Load More',
      empty: zh ? '当前没有线程。' : 'No threads yet.',
      currentTextMarker: zh ? ' [当前]' : ' [current]',
      pageSummary(start: number, end: number): string {
        return zh
          ? `本页显示第 ${start}-${end} 条线程。`
          : `Showing threads ${start}-${end} on this page.`;
      },
      clickLoadMore: zh ? '请在卡片中点击“查看更多”。' : 'Click "Load More" on the card.',
      switchHint: zh ? '切换: 切换线程 2' : 'Switch: /thread switch 2',
    },

    projectPicker: {
      title: zh ? '项目' : 'Projects',
      empty: zh ? '当前没有可用项目。' : 'No projects available.',
      chatRoot: zh ? '聊天根层' : 'Chat root',
      noThreads: zh ? '暂无线程' : 'No threads yet',
      threads(count: number): string {
        return zh ? `${count} 条线程` : `${count} thread${count === 1 ? '' : 's'}`;
      },
      currentProject: zh ? '当前项目' : 'Current project',
      recent(value: string): string {
        return zh ? `最近 ${value}` : `Recent ${value}`;
      },
      viewThreads: zh ? '查看线程' : 'View Threads',
      createHere: zh ? '在此新建' : 'New Here',
      projectList: zh ? '项目列表' : 'Project List',
      useProject: zh ? '使用项目' : 'Use Project',
      projectThreadsTitle(projectName: string): string {
        return zh ? `${projectName} · 线程` : `${projectName} Threads`;
      },
      projectSubtitle(projectName: string): string {
        return zh ? `项目：${projectName}` : `Project: ${projectName}`;
      },
      showProjectThreadsHint: zh ? '查看项目线程: /project threads 2' : 'View project threads: /project threads 2',
      setCurrentProjectHint: zh ? '设为当前项目: /project use 2' : 'Set current project: /project use 2',
      createInProjectHint: zh ? '在项目下新建: /project new 2' : 'Create in project: /project new 2',
    },
  };
}
