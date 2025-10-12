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
    save: "保存"
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
    save: "Save"
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
    return { enableChecklist, autoDelete, retentionDays, language };
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
        }

        data = pruneChecklist(data);
        saveData(data);
        statusBarItem.text = getProgressText(data.tasks, data.checklist);
        panel.webview.html = getWebviewContent(data.tasks, data.checklist, cfg);
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

function getWebviewContent(tasks: any[], checklist: any[], cfg: { enableChecklist: boolean; autoDelete: boolean; retentionDays: number; language: string }): string {
  const total = tasks.length + checklist.length;
  const completed = checklist.length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
  const barLength = 10;
  const filled = Math.round((progress / 100) * barLength);
  const bar = "█".repeat(filled) + " ".repeat(barLength - filled);
  const t = getStrings(cfg.language);
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <style>
        body {
          font-family: "Segoe UI", sans-serif;
          padding: 20px;
          background: linear-gradient(135deg, #1e1e2f, #121212);
          color: #fff;
        }
        .progress-label {
          text-align: center;
          font-size: 16px;
          color: #fff;
          margin-bottom: 18px;
          letter-spacing: 1px;
        }
        h2 {
          text-align: center;
          color: #fff;
          margin-bottom: 16px;
        }
        .tabs {
          display: flex;
          gap: 8px;
          justify-content: center;
          margin-bottom: 12px;
        }
        .tab-btn {
          padding: 6px 10px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.2);
          background: rgba(255,255,255,0.08);
          color: #fff;
          cursor: pointer;
        }
        .tab-btn.active {
          background: rgba(0,120,212,0.8);
        }
        ul {
          list-style: none;
          padding: 0;
        }
        li {
          backdrop-filter: blur(12px) saturate(180%);
          -webkit-backdrop-filter: blur(12px) saturate(180%);
          background-color: rgba(40, 40, 40, 0.5);
          margin: 10px 0;
          padding: 12px 16px;
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          box-shadow: 0 4px 10px rgba(0,0,0,0.4);
        }
        .task-title {
          flex: 1;
          margin-left: 10px;
          font-size: 15px;
        }
        .done { text-decoration: line-through; opacity: 0.6; }
        button {
          border: none;
          cursor: pointer;
          margin-left: 6px;
          border-radius: 8px;
          padding: 6px 8px;
          font-size: 14px;
          background: rgba(255,255,255,0.1);
          color: white;
          transition: background 0.2s;
        }
        button:hover {
          background: rgba(255,255,255,0.25);
        }
        #taskInput {
          width: 70%;
          padding: 8px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.2);
          background: rgba(255,255,255,0.1);
          color: white;
        }
        #taskInput::placeholder {
          color: rgba(255,255,255,0.5);
        }
        #addBtn {
          padding: 8px 14px;
          margin-left: 10px;
          background: rgba(0,120,212,0.7);
          color: white;
          border-radius: 8px;
        }
        #addBtn:hover {
          background: rgba(0,120,212,1);
        }
      </style>
    </head>
    <body>
      <div class="progress-label">[${bar}] ${progress}% ${t.completePercent}🎉</div>
      <h2>✔ ${t.taskManager}</h2>
      <div class="tabs">
        <button class="tab-btn active" id="tabTasks" onclick="showTab('tasks')">${t.tasks}</button>
        <button class="tab-btn" id="tabChecklist" onclick="showTab('checklist')">${t.checklist}</button>
        <button class="tab-btn" id="tabSettings" onclick="showTab('settings')">⚙️ ${t.settings}</button>
      </div>

      <div id="viewTasks">
        <ul>
          ${tasks.map((t, i) =>
            `<li>
              <button onclick="toggleTask(${i})">✅</button>
              <span class="task-title">${t.title}</span>
              <button onclick="editTask(${i})">✏️</button>
              <button onclick="deleteTask(${i}, 'tasks')">🗑</button>
            </li>`
          ).join("")}
        </ul>
        <div style="margin-top:16px; text-align:center;">
          <input id="taskInput" placeholder="${t.newTask}">
          <button id="addBtn" onclick="addTask()">${t.add}</button>
        </div>
      </div>

      <div id="viewChecklist" style="display:none;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <div>${t.autoDelete}: ${cfg.autoDelete ? `${t.on}（${cfg.retentionDays}${t.days}）` : t.off}</div>
          <button onclick="purgeOldCompleted()">${t.purgeOld}</button>
        </div>
        <ul>
          ${checklist.map((c, i) =>
            `<li>
              <span class="task-title done">${c.title}</span>
              <span style="opacity:0.7; margin-right:8px;">${formatDate(c.completedAt)}</span>
              <button onclick="restoreTask(${i})">↩️ ${t.restore}</button>
              <button onclick="deleteTask(${i}, 'checklist')">🗑</button>
            </li>`
          ).join("")}
        </ul>
      </div>

      <div id="viewSettings" style="display:none;">
        <div style="margin-bottom: 20px;">
          <h3>${t.autoDelete}</h3>
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
            <label style="display: flex; align-items: center; gap: 5px;">
              <input type="checkbox" id="autoDeleteToggle" ${cfg.autoDelete ? 'checked' : ''} onchange="toggleAutoDelete()">
              ${t.autoDelete}
            </label>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
            <label for="retentionDaysInput">${t.retentionDays}:</label>
            <input type="number" id="retentionDaysInput" value="${cfg.retentionDays}" min="1" max="365" style="width: 80px; padding: 4px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.1); color: white;">
            <span>${t.days}</span>
            <button onclick="updateRetentionDays()">${t.save}</button>
          </div>
        </div>
        <div style="margin-bottom: 20px;">
          <h3>${t.language}</h3>
          <button onclick="toggleLanguage()">🌐 ${cfg.language === 'ja' ? 'English' : '日本語'}</button>
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
          if (input.value.trim() !== '') {
            vscode.postMessage({ command: 'addTask', title: input.value });
            input.value = '';
          }
        }
        function toggleTask(index) {
          vscode.postMessage({ command: 'toggleTask', index });
        }
        function editTask(index) {
          vscode.postMessage({ command: 'editTask', index });
        }
        function deleteTask(index, scope) {
          vscode.postMessage({ command: 'deleteTask', index, scope });
        }
        function restoreTask(index) {
          vscode.postMessage({ command: 'restoreTask', index });
        }
        function purgeOldCompleted() {
          vscode.postMessage({ command: 'purgeOldCompleted' });
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
          }
        }
      </script>
    </body>
    </html>`;
}

export function deactivate() {}
