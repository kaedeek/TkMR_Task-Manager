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
  const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || "";
  const tasksFile = path.join(rootPath, "tasks.json");

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = "taskManager.open";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  type ActiveTask = { title: string; done: boolean; createdAt: number };
  type CompletedTask = { title: string; completedAt: number };
  type StoredData = { tasks: ActiveTask[]; checklist: CompletedTask[] };

  function readConfig() {
    const cfg = vscode.workspace.getConfiguration();
    const enableChecklist = cfg.get<boolean>("taskManager.enableChecklist", true);
    const autoDelete = cfg.get<boolean>("taskManager.autoDeleteCompleted", true);
    const retentionDays = cfg.get<number>("taskManager.retentionDays", 7);
    const language = cfg.get<string>("taskManager.language", "ja");
    const theme = cfg.get<string>("taskManager.theme", "white");
    return { enableChecklist, autoDelete, retentionDays, language, theme };
  }

  function getProgressText(tasks: ActiveTask[], checklist: CompletedTask[]): string {
    const total = tasks.length + checklist.length;
    const completed = checklist.length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    const barLength = 10;
    const filled = Math.round((progress / 100) * barLength);
    const bar = "█".repeat(filled) + " ".repeat(barLength - filled);
    return `✔ Task Manager [${bar}] ${progress}%`;
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
          try {
            const parsed = JSON.parse(fs.readFileSync(tasksFile, "utf-8"));
            if (Array.isArray(parsed?.tasks) && !parsed?.checklist) {
              const migratedTasks: ActiveTask[] = parsed.tasks.map((t: any) => ({ title: t.title, done: !!t.done, createdAt: Date.now() }));
              return { tasks: migratedTasks, checklist: [] };
            }
            if (Array.isArray(parsed?.tasks) && Array.isArray(parsed?.checklist)) {
              return parsed as StoredData;
            }
          } catch {}
        }
        return { tasks: [], checklist: [] };
      }

      function saveData(data: StoredData) {
        fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2));
      }

      function pruneChecklist(data: StoredData): StoredData {
        const { autoDelete, retentionDays } = readConfig();
        if (!autoDelete) {
          return data;
        }
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const pruned = { ...data, checklist: data.checklist.filter(c => c.completedAt >= cutoff) };
        return pruned;
      }

      let data = pruneChecklist(loadData());
      saveData(data);
      statusBarItem.text = getProgressText(data.tasks, data.checklist);
      panel.webview.html = getWebviewContent(data.tasks, data.checklist, readConfig());

      panel.webview.onDidReceiveMessage(async (message) => {
        const cfg = readConfig();
        if (message.command === "addTask") {
          data.tasks.push({ title: message.title, done: false, createdAt: Date.now() });
        } else if (message.command === "toggleTask") {
          const idx = message.index as number;
          const current = data.tasks[idx];
          if (!current) {
            return;
          }
          if (cfg.enableChecklist) {
            data.tasks.splice(idx, 1);
            data.checklist.unshift({ title: current.title, completedAt: Date.now() });
          } else {
            data.tasks[idx] = { ...current, done: !current.done };
          }
        } else if (message.command === "editTask") {
          await vscode.commands.executeCommand("taskManager.editTask", message.index);
        } else if (message.command === "deleteTask") {
          const idx = message.index as number;
          if (message.scope === "tasks") {
            data.tasks.splice(idx, 1);
          } else if (message.scope === "checklist") {
            data.checklist.splice(idx, 1);
          }
        } else if (message.command === "restoreTask") {
          const idx = message.index as number;
          const item = data.checklist[idx];
          if (!item) {
            return;
          }
          data.checklist.splice(idx, 1);
          data.tasks.unshift({ title: item.title, done: false, createdAt: Date.now() });
        } else if (message.command === "purgeOldCompleted") {
          data = pruneChecklist(data);
        } else if (message.command === "toggleLanguage") {
          const currentLang = cfg.language;
          const newLang = currentLang === "ja" ? "en" : "ja";
          await vscode.workspace.getConfiguration().update("taskManager.language", newLang, vscode.ConfigurationTarget.Global);
          cfg.language = newLang;
        } else if (message.command === "toggleAutoDelete") {
          const newAutoDelete = !cfg.autoDelete;
          await vscode.workspace.getConfiguration().update("taskManager.autoDeleteCompleted", newAutoDelete, vscode.ConfigurationTarget.Global);
          cfg.autoDelete = newAutoDelete;
        } else if (message.command === "updateRetentionDays") {
          const newDays = Math.max(1, Math.min(365, parseInt(message.days) || 7));
          await vscode.workspace.getConfiguration().update("taskManager.retentionDays", newDays, vscode.ConfigurationTarget.Global);
          cfg.retentionDays = newDays;
        } else if (message.command === "toggleTheme") {
          const currentTheme = cfg.theme;
          let newTheme: string;
          switch (currentTheme) {
            case "red":
              newTheme = "blue";
              break;
            case "blue":
              newTheme = "white";
              break;
            case "white":
              newTheme = "black";
              break;
            case "black":
              newTheme = "rainbow";
              break;
            case "rainbow":
              newTheme = "red";
              break;
            default:
              newTheme = "white";
          }
          await vscode.workspace.getConfiguration().update("taskManager.theme", newTheme, vscode.ConfigurationTarget.Global);
          cfg.theme = newTheme;
        }

        data = pruneChecklist(data);
        saveData(data);
        statusBarItem.text = getProgressText(data.tasks, data.checklist);
        const updatedConfig = readConfig();
        panel.webview.html = getWebviewContent(data.tasks, data.checklist, updatedConfig);
      });

      context.subscriptions.push(
        vscode.commands.registerCommand("taskManager.editTask", async (index: number) => {
          const newTitle = await vscode.window.showInputBox({
            prompt: "Enter new task title",
            value: data.tasks[index]?.title || "",
          });
          if (newTitle) {
            if (!data.tasks[index]) {
              return;
            }
            data.tasks[index].title = newTitle;
            saveData(data);

            statusBarItem.text = getProgressText(data.tasks, data.checklist);
            panel.webview.html = getWebviewContent(data.tasks, data.checklist, readConfig());
          }
        })
      );

      context.subscriptions.push(
        vscode.commands.registerCommand("taskManager.deleteTask", (index: number) => {
          data.tasks.splice(index, 1);
          saveData(data);

          statusBarItem.text = getProgressText(data.tasks, data.checklist);
          panel.webview.html = getWebviewContent(data.tasks, data.checklist, readConfig());
        })
      );
    })
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getThemeColors(theme: string) {
  switch (theme) {
    case "red":
      return {
        bg1: "#1a0a0a",
        bg2: "#2d1414",
        bg3: "#3d1f1f",
        cardBg: "rgba(139, 0, 0, 0.25)",
        cardBorder: "rgba(220, 20, 60, 0.3)",
        accent: "linear-gradient(135deg, #dc143c, #8b0000)",
        accentSolid: "#dc143c",
        text: "#ffffff",
        textSecondary: "rgba(255, 255, 255, 0.7)",
        shadow: "rgba(220, 20, 60, 0.4)"
      };
    case "blue":
      return {
        bg1: "#0a0e1a",
        bg2: "#141b2d",
        bg3: "#1e2840",
        cardBg: "rgba(30, 58, 138, 0.25)",
        cardBorder: "rgba(59, 130, 246, 0.3)",
        accent: "linear-gradient(135deg, #3b82f6, #1e40af)",
        accentSolid: "#3b82f6",
        text: "#ffffff",
        textSecondary: "rgba(255, 255, 255, 0.7)",
        shadow: "rgba(59, 130, 246, 0.4)"
      };
    case "white":
      return {
        bg1: "#f8f9fa",
        bg2: "#e9ecef",
        bg3: "#dee2e6",
        cardBg: "rgba(255, 255, 255, 0.95)",
        cardBorder: "rgba(0, 0, 0, 0.1)",
        accent: "linear-gradient(135deg, #4f46e5, #7c3aed)",
        accentSolid: "#4f46e5",
        text: "#212529",
        textSecondary: "rgba(33, 37, 41, 0.7)",
        shadow: "rgba(0, 0, 0, 0.1)"
      };
    case "black":
      return {
        bg1: "#000000",
        bg2: "#0a0a0a",
        bg3: "#141414",
        cardBg: "rgba(30, 30, 30, 0.95)",
        cardBorder: "rgba(255, 255, 255, 0.1)",
        accent: "linear-gradient(135deg, #ffffff, #a0a0a0)",
        accentSolid: "#ffffff",
        text: "#ffffff",
        textSecondary: "rgba(255, 255, 255, 0.6)",
        shadow: "rgba(255, 255, 255, 0.2)"
      };
    case "rainbow":
      return {
        bg1: "#0f0c29",
        bg2: "#1a1442",
        bg3: "#2d1f5c",
        cardBg: "rgba(75, 0, 130, 0.2)",
        cardBorder: "rgba(148, 0, 211, 0.4)",
        accent: "linear-gradient(135deg, #ff0000, #ff7f00, #ffff00, #00ff00, #0000ff, #4b0082, #9400d3)",
        accentSolid: "#9400d3",
        text: "#ffffff",
        textSecondary: "rgba(255, 255, 255, 0.8)",
        shadow: "rgba(148, 0, 211, 0.5)"
      };
    default:
      return {
        bg1: "#f8f9fa",
        bg2: "#e9ecef",
        bg3: "#dee2e6",
        cardBg: "rgba(255, 255, 255, 0.95)",
        cardBorder: "rgba(0, 0, 0, 0.1)",
        accent: "linear-gradient(135deg, #4f46e5, #7c3aed)",
        accentSolid: "#4f46e5",
        text: "#212529",
        textSecondary: "rgba(33, 37, 41, 0.7)",
        shadow: "rgba(0, 0, 0, 0.1)"
      };
  }
}

function getWebviewContent(tasks: any[], checklist: any[], cfg: { enableChecklist: boolean; autoDelete: boolean; retentionDays: number; language: string; theme: string }): string {
  const total = tasks.length + checklist.length;
  const completed = checklist.length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
  const barLength = 10;
  const filled = Math.round((progress / 100) * barLength);
  const bar = "█".repeat(filled) + " ".repeat(barLength - filled);
  const t = getStrings(cfg.language);
  const theme = cfg.theme;
  const colors = getThemeColors(theme);

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
          padding: 24px;
          background: linear-gradient(135deg, ${colors.bg1} 0%, ${colors.bg2} 50%, ${colors.bg3} 100%);
          background-attachment: fixed;
          color: ${colors.text};
          min-height: 100vh;
          animation: fadeIn 0.5s ease-in;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
        }
        .progress-container {
          background: ${colors.cardBg};
          backdrop-filter: blur(20px) saturate(180%);
          -webkit-backdrop-filter: blur(20px) saturate(180%);
          border: 1px solid ${colors.cardBorder};
          border-radius: 16px;
          padding: 20px;
          margin-bottom: 24px;
          box-shadow: 0 8px 32px ${colors.shadow}40, 0 4px 16px rgba(0,0,0,0.2);
          animation: slideDown 0.4s ease-out;
        }
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .progress-label {
          text-align: center;
          font-size: 18px;
          font-weight: 600;
          color: ${colors.text};
          margin-bottom: 12px;
          letter-spacing: 0.5px;
        }
        .progress-bar-container {
          width: 100%;
          height: 12px;
          background: ${colors.bg3};
          border-radius: 10px;
          overflow: hidden;
          margin: 12px 0;
          box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
        }
        .progress-bar-fill {
          height: 100%;
          background: ${colors.accent};
          border-radius: 10px;
          transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 0 20px ${colors.shadow}60;
          animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.9; }
        }
        .progress-text {
          text-align: center;
          font-size: 24px;
          font-weight: 700;
          background: ${colors.accent};
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          margin-top: 8px;
        }
        h2 {
          text-align: center;
          color: ${colors.text};
          margin-bottom: 24px;
          font-size: 32px;
          font-weight: 700;
          text-shadow: 0 2px 8px ${colors.shadow}40;
        }
        .tabs {
          display: flex;
          gap: 12px;
          justify-content: center;
          margin-bottom: 24px;
          flex-wrap: wrap;
        }
        .tab-btn {
          padding: 12px 24px;
          border-radius: 12px;
          border: 2px solid ${colors.cardBorder};
          background: ${colors.cardBg};
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          color: ${colors.text};
          cursor: pointer;
          font-size: 15px;
          font-weight: 600;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          position: relative;
          overflow: hidden;
        }
        .tab-btn::before {
          content: '';
          position: absolute;
          top: 50%;
          left: 50%;
          width: 0;
          height: 0;
          border-radius: 50%;
          background: ${colors.accent};
          transform: translate(-50%, -50%);
          transition: width 0.6s, height 0.6s;
        }
        .tab-btn:hover::before {
          width: 300px;
          height: 300px;
        }
        .tab-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px ${colors.shadow}50;
          border-color: ${colors.accentSolid};
        }
        .tab-btn.active {
          background: ${colors.accent};
          border-color: ${colors.accentSolid};
          color: white;
          box-shadow: 0 6px 20px ${colors.shadow}60;
          transform: translateY(-2px);
        }
        .tab-btn > * {
          position: relative;
          z-index: 1;
        }
        .view-container {
          animation: fadeIn 0.4s ease-in;
        }
        ul {
          list-style: none;
          padding: 0;
        }
        li {
          backdrop-filter: blur(20px) saturate(180%);
          -webkit-backdrop-filter: blur(20px) saturate(180%);
          background: ${colors.cardBg};
          border: 1px solid ${colors.cardBorder};
          margin: 12px 0;
          padding: 16px 20px;
          border-radius: 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          box-shadow: 0 4px 16px rgba(0,0,0,0.15), 0 2px 8px ${colors.shadow}20;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          animation: slideIn 0.4s ease-out backwards;
        }
        li:nth-child(1) { animation-delay: 0.05s; }
        li:nth-child(2) { animation-delay: 0.1s; }
        li:nth-child(3) { animation-delay: 0.15s; }
        li:nth-child(4) { animation-delay: 0.2s; }
        li:nth-child(5) { animation-delay: 0.25s; }
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(-20px); }
          to { opacity: 1; transform: translateX(0); }
        }
        li:hover {
          transform: translateY(-2px) scale(1.01);
          box-shadow: 0 8px 24px rgba(0,0,0,0.2), 0 4px 12px ${colors.shadow}40;
          border-color: ${colors.accentSolid};
        }
        .task-title {
          flex: 1;
          margin-left: 12px;
          font-size: 16px;
          font-weight: 500;
          color: ${colors.text};
          word-break: break-word;
        }
        .done { 
          text-decoration: line-through; 
          opacity: 0.5; 
          color: ${colors.textSecondary};
        }
        .task-date {
          opacity: 0.7;
          margin-right: 12px;
          font-size: 13px;
          color: ${colors.textSecondary};
          font-weight: 500;
        }
        button {
          border: none;
          cursor: pointer;
          margin-left: 8px;
          border-radius: 10px;
          padding: 8px 12px;
          font-size: 14px;
          font-weight: 600;
          background: ${colors.bg3};
          color: ${colors.text};
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          position: relative;
          overflow: hidden;
        }
        button:not(.tab-btn):not(#addBtn):hover {
          background: ${colors.accent};
          color: white;
          transform: scale(1.05);
          box-shadow: 0 4px 12px ${colors.shadow}50;
        }
        button:not(.tab-btn):not(#addBtn):active {
          transform: scale(0.95);
        }
        .task-input-container {
          margin-top: 24px;
          display: flex;
          gap: 12px;
          align-items: stretch;
        }
        #taskInput {
          flex: 1;
          padding: 14px 18px;
          border-radius: 12px;
          border: 2px solid ${colors.cardBorder};
          background: ${colors.cardBg};
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          color: ${colors.text};
          font-size: 15px;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        #taskInput:focus {
          outline: none;
          border-color: ${colors.accentSolid};
          box-shadow: 0 4px 16px ${colors.shadow}40;
          transform: translateY(-2px);
        }
        #taskInput::placeholder {
          color: ${colors.textSecondary};
        }
        #addBtn {
          padding: 14px 28px;
          background: ${colors.accent};
          color: white;
          border-radius: 12px;
          font-weight: 700;
          font-size: 15px;
          box-shadow: 0 4px 16px ${colors.shadow}50;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        #addBtn:hover {
          transform: translateY(-2px) scale(1.05);
          box-shadow: 0 6px 24px ${colors.shadow}70;
        }
        #addBtn:active {
          transform: translateY(0) scale(1);
        }
        .settings-section {
          background: ${colors.cardBg};
          backdrop-filter: blur(20px) saturate(180%);
          -webkit-backdrop-filter: blur(20px) saturate(180%);
          border: 1px solid ${colors.cardBorder};
          border-radius: 16px;
          padding: 24px;
          margin-bottom: 20px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.15);
        }
        .settings-section h3 {
          font-size: 20px;
          font-weight: 700;
          margin-bottom: 16px;
          color: ${colors.text};
          border-bottom: 2px solid ${colors.cardBorder};
          padding-bottom: 12px;
        }
        .settings-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 16px;
          padding: 12px;
          border-radius: 10px;
          background: ${colors.bg3}40;
          transition: all 0.2s;
        }
        .settings-item:hover {
          background: ${colors.bg3}60;
        }
        .settings-item label {
          display: flex;
          align-items: center;
          gap: 10px;
          font-weight: 500;
          color: ${colors.text};
          cursor: pointer;
        }
        .settings-item input[type="checkbox"] {
          width: 20px;
          height: 20px;
          cursor: pointer;
          accent-color: ${colors.accentSolid};
        }
        .settings-item input[type="number"] {
          width: 100px;
          padding: 8px 12px;
          border-radius: 8px;
          border: 2px solid ${colors.cardBorder};
          background: ${colors.cardBg};
          color: ${colors.text};
          font-size: 14px;
          font-weight: 600;
        }
        .settings-item input[type="number"]:focus {
          outline: none;
          border-color: ${colors.accentSolid};
          box-shadow: 0 0 0 3px ${colors.shadow}30;
        }
        .theme-btn, .lang-btn {
          padding: 12px 24px;
          border-radius: 12px;
          border: 2px solid ${colors.cardBorder};
          background: ${colors.accent};
          color: white;
          font-weight: 700;
          font-size: 15px;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 4px 16px ${colors.shadow}50;
          width: 100%;
        }
        .theme-btn:hover, .lang-btn:hover {
          transform: translateY(-2px) scale(1.02);
          box-shadow: 0 6px 24px ${colors.shadow}70;
        }
        .purge-btn {
          padding: 10px 20px;
          border-radius: 10px;
          border: 2px solid ${colors.cardBorder};
          background: ${colors.cardBg};
          color: ${colors.text};
          font-weight: 600;
          cursor: pointer;
          transition: all 0.3s;
        }
        .purge-btn:hover {
          background: ${colors.accent};
          color: white;
          border-color: ${colors.accentSolid};
          transform: translateY(-2px);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>✨ ${t.taskManager}</h2>
        <div class="progress-container">
          <div class="progress-label">${t.progress}</div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" style="width: ${progress}%"></div>
          </div>
          <div class="progress-text">${progress}% ${t.completePercent} 🎉</div>
        </div>
        <div class="tabs">
          <button class="tab-btn active" id="tabTasks" onclick="showTab('tasks')">📋 ${t.tasks}</button>
          <button class="tab-btn" id="tabChecklist" onclick="showTab('checklist')">✅ ${t.checklist}</button>
          <button class="tab-btn" id="tabSettings" onclick="showTab('settings')">⚙️ ${t.settings}</button>
        </div>

        <div id="viewTasks" class="view-container">
          <ul>
            ${tasks.length === 0 ? `<li style="text-align: center; padding: 40px; opacity: 0.6;"><em>${cfg.language === 'ja' ? t.newTask + 'を追加してください' : 'Please add a ' + t.newTask.toLowerCase()}</em></li>` : tasks.map((task, i) =>
              `<li>
                <button onclick="toggleTask(${i})" title="${t.complete}">✅</button>
                <span class="task-title">${task.title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
                <button onclick="editTask(${i})" title="${t.edit}">✏️</button>
                <button onclick="deleteTask(${i}, 'tasks')" title="${t.delete}">🗑️</button>
              </li>`
            ).join("")}
          </ul>
          <div class="task-input-container">
            <input id="taskInput" placeholder="${t.newTask}" onkeypress="if(event.key==='Enter') addTask()">
            <button id="addBtn" onclick="addTask()">➕ ${t.add}</button>
          </div>
        </div>

        <div id="viewChecklist" class="view-container" style="display:none;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding:16px; background: ${colors.cardBg}; border-radius:12px; border: 1px solid ${colors.cardBorder};">
            <div style="font-weight:600; color:${colors.text};">${t.autoDelete}: <span style="color:${colors.accentSolid};">${cfg.autoDelete ? `${t.on}（${cfg.retentionDays}${t.days}）` : t.off}</span></div>
            <button class="purge-btn" onclick="purgeOldCompleted()">🗑️ ${t.purgeOld}</button>
          </div>
          <ul>
            ${checklist.length === 0 ? `<li style="text-align: center; padding: 40px; opacity: 0.6;"><em>${cfg.language === 'ja' ? '完了したタスクはありません' : 'No completed tasks'}</em></li>` : checklist.map((c, i) =>
              `<li>
                <span class="task-title done">${c.title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
                <span class="task-date">${formatDate(c.completedAt)}</span>
                <button onclick="restoreTask(${i})" title="${t.restore}">↩️ ${t.restore}</button>
                <button onclick="deleteTask(${i}, 'checklist')" title="${t.delete}">🗑️</button>
              </li>`
            ).join("")}
          </ul>
        </div>

        <div id="viewSettings" class="view-container" style="display:none;">
          <div class="settings-section">
            <h3>⚙️ ${t.autoDelete}</h3>
            <div class="settings-item">
              <label>
                <input type="checkbox" id="autoDeleteToggle" ${cfg.autoDelete ? 'checked' : ''} onchange="toggleAutoDelete()">
                ${t.autoDelete}
              </label>
            </div>
            <div class="settings-item">
              <label for="retentionDaysInput" style="flex: 1;">${t.retentionDays}:</label>
              <input type="number" id="retentionDaysInput" value="${cfg.retentionDays}" min="1" max="365">
              <span>${t.days}</span>
              <button onclick="updateRetentionDays()">💾 ${t.save}</button>
            </div>
          </div>
          <div class="settings-section">
            <h3>🎨 ${t.theme}</h3>
            <button class="theme-btn" onclick="toggleTheme()">${cfg.theme === 'red' ? '🔴 ' + t.themeRed : cfg.theme === 'blue' ? '🔵 ' + t.themeBlue : cfg.theme === 'white' ? '⚪ ' + t.themeWhite : cfg.theme === 'black' ? '⚫ ' + t.themeBlack : '🌈 ' + t.themeRainbow}</button>
          </div>
          <div class="settings-section">
            <h3>🌐 ${t.language}</h3>
            <button class="lang-btn" onclick="toggleLanguage()">🌐 ${cfg.language === 'ja' ? 'English' : '日本語'}</button>
          </div>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        function showTab(tab) {
          const tasks = document.getElementById('viewTasks');
          const checklist = document.getElementById('viewChecklist');
          const settings = document.getElementById('viewSettings');
          const tBtn = document.getElementById('tabTasks');
          const cBtn = document.getElementById('tabChecklist');
          const sBtn = document.getElementById('tabSettings');
          
          tasks.style.display = tab === 'tasks' ? 'block' : 'none';
          checklist.style.display = tab === 'checklist' ? 'block' : 'none';
          settings.style.display = tab === 'settings' ? 'block' : 'none';
          
          tBtn.classList.toggle('active', tab === 'tasks');
          cBtn.classList.toggle('active', tab === 'checklist');
          sBtn.classList.toggle('active', tab === 'settings');
        }
        function addTask() {
          const input = document.getElementById('taskInput');
          const value = input.value.trim();
          if (value !== '') {
            vscode.postMessage({ command: 'addTask', title: value });
            input.value = '';
            input.focus();
          }
        }
        function toggleTask(index) {
          vscode.postMessage({ command: 'toggleTask', index });
        }
        function editTask(index) {
          vscode.postMessage({ command: 'editTask', index });
        }
        function deleteTask(index, scope) {
          const msg = '${cfg.language === 'ja' ? t.delete + 'しますか？' : 'Are you sure you want to delete?'}';
          if (confirm(msg)) {
            vscode.postMessage({ command: 'deleteTask', index, scope });
          }
        }
        function restoreTask(index) {
          vscode.postMessage({ command: 'restoreTask', index });
        }
        function purgeOldCompleted() {
          const msg = '${cfg.language === 'ja' ? t.purgeOld + 'しますか？' : 'Are you sure you want to purge old completed tasks?'}';
          if (confirm(msg)) {
            vscode.postMessage({ command: 'purgeOldCompleted' });
          }
        }
        function toggleLanguage() {
          vscode.postMessage({ command: 'toggleLanguage' });
        }
        function toggleAutoDelete() {
          vscode.postMessage({ command: 'toggleAutoDelete' });
        }
        function updateRetentionDays() {
          const input = document.getElementById('retentionDaysInput');
          const days = parseInt(input.value);
          if (days >= 1 && days <= 365) {
            vscode.postMessage({ command: 'updateRetentionDays', days: days });
          } else {
            const msg = '${cfg.language === 'ja' ? '1から365の間で入力してください' : 'Please enter a number between 1 and 365'}';
            alert(msg);
          }
        }
        function toggleTheme() {
          vscode.postMessage({ command: 'toggleTheme' });
        }
        document.addEventListener('DOMContentLoaded', function() {
          const input = document.getElementById('taskInput');
          if (input) {
            input.focus();
          }
        });
      </script>
    </body>
    </html>`;
}

export function deactivate() {}
