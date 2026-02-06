import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

const strings = {
  ja: {
    taskManager: "タスク管理",
    tasks: "タスク",
    checklist: "チェックリスト",
    settings: "設定",
    newTask: "新しいタスク",
    add: "追加",
    complete: "完了",
    edit: "編集",
    delete: "削除",
    restore: "戻す",
    purgeOld: "期限切れを手動整理",
    autoDelete: "自動削除",
    on: "ON",
    off: "OFF",
    days: "日",
    completePercent: "完了",
    progress: "進捗",
    language: "言語",
    retentionDays: "保持日数",
    save: "保存",
    theme: "テーマ",
    themeRed: "赤",
    themeBlue: "青",
    themeWhite: "白",
    themeBlack: "黒",
    themeRainbow: "虹色"
  },
  en: {
    taskManager: "Task Management",
    tasks: "Tasks",
    checklist: "Checklist",
    settings: "Settings",
    newTask: "New Task",
    add: "Add",
    complete: "Complete",
    edit: "Edit",
    delete: "Delete",
    restore: "Restore",
    purgeOld: "Purge Old Completed",
    autoDelete: "Auto Delete",
    on: "ON",
    off: "OFF",
    days: "days",
    completePercent: "Complete",
    progress: "Progress",
    language: "Language",
    retentionDays: "Retention Days",
    save: "Save",
    theme: "Theme",
    themeRed: "Red",
    themeBlue: "Blue",
    themeWhite: "White",
    themeBlack: "Black",
    themeRainbow: "Rainbow"
  }
};

function getStrings(language: string) {
  return strings[language as keyof typeof strings] || strings.ja;
}

export function activate(context: vscode.ExtensionContext) {
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
  const tasksFile = path.join(rootPath, "tasks.json");

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = "taskManager.open";
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);

  type ActiveTask = { title: string; done: boolean; createdAt: number };
  type CompletedTask = { title: string; completedAt: number };
  type StoredData = { tasks: ActiveTask[]; checklist: CompletedTask[] };

  function readConfig() {
    const cfg = vscode.workspace.getConfiguration();

    return {
      enableChecklist: cfg.get<boolean>("taskManager.enableChecklist", true),
      autoDelete: cfg.get<boolean>("taskManager.autoDeleteCompleted", true),
      retentionDays: cfg.get<number>("taskManager.retentionDays", 7),
      language: cfg.get<string>("taskManager.language", "ja"),
      theme: cfg.get<string>("taskManager.theme", "white")
    };
  }

  function getProgressText(tasks: ActiveTask[], checklist: CompletedTask[]) {
    const total = tasks.length + checklist.length;
    const completed = checklist.length;
    const progress = total ? Math.round((completed / total) * 100) : 0;

    const barLength = 10;
    const filled = Math.round((progress / 100) * barLength);

    return `✔ Task Manager [${"█".repeat(filled)}${" ".repeat(
      barLength - filled
    )}] ${progress}%`;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("taskManager.open", () => {
      const panel = vscode.window.createWebviewPanel(
        "taskManager",
        "Task Management",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      function loadData(): StoredData {
        if (fs.existsSync(tasksFile)) {
          return JSON.parse(fs.readFileSync(tasksFile, "utf8"));
        }
        return { tasks: [], checklist: [] };
      }

      function saveData(d: StoredData) {
        fs.writeFileSync(tasksFile, JSON.stringify(d, null, 2));
      }

      function render(data: StoredData) {
        const cfg = readConfig();

        statusBarItem.text = getProgressText(data.tasks, data.checklist);

        panel.webview.html = getWebviewContent(
          data.tasks,
          data.checklist,
          cfg
        );
      }

      let data = loadData();
      render(data);

      panel.webview.onDidReceiveMessage(async (msg) => {
        const cfg = readConfig();

        if (msg.command === "addTask") {
          data.tasks.push({
            title: msg.title,
            done: false,
            createdAt: Date.now()
          });
        }

        else if (msg.command === "toggleTheme") {
          const current = readConfig().theme;

          const order = ["red", "blue", "white", "black", "rainbow"];
          const next = order[(order.indexOf(current) + 1) % order.length];

          await vscode.workspace
            .getConfiguration()
            .update("taskManager.theme", next, vscode.ConfigurationTarget.Global);
        }

        saveData(data);
        render(data);
      });
    })
  );
}

function getWebviewContent(tasks: any[], checklist: any[], cfg: any): string {
  return `<html><body><h2>Theme: ${cfg.theme}</h2></body></html>`;
}

export function deactivate() {}
