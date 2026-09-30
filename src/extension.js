'use strict';

const vscode = require('vscode');
const { parseIni } = require('./parser');
const { diffModels } = require('./diff');

const VIEW_TYPE = 'iniTableView.editor';

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new IniTableProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true
    }),

    vscode.commands.registerCommand('iniTableView.openAsText', async (uri) => {
      uri = uri || activeUri();
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),

    vscode.commands.registerCommand('iniTableView.openAsTable', async (uri) => {
      uri = uri || activeUri();
      if (!uri) return;
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      offerDefault(context);
    }),

    vscode.commands.registerCommand('iniTableView.setAsDefault', () => setDefault(true)),
    vscode.commands.registerCommand('iniTableView.unsetDefault', () => setDefault(false))
  );
}

// Opt-in "open every .ini as a table", via VS Code's own editor associations setting
const isDefault = () => (vscode.workspace.getConfiguration('workbench').get('editorAssociations') || {})['*.ini'] === VIEW_TYPE;

async function setDefault(on) {
  const cfg = vscode.workspace.getConfiguration('workbench');
  const assoc = { ...(cfg.get('editorAssociations') || {}) };
  if (on) assoc['*.ini'] = VIEW_TYPE;
  else if (assoc['*.ini'] === VIEW_TYPE) delete assoc['*.ini'];
  await cfg.update('editorAssociations', assoc, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(on
    ? '.ini files will now open as tables. Use "INI: Open as Text" whenever you need the raw file.'
    : '.ini files will open as text again. Use "INI: Open as Table" when you want the table view.');
}

// Ask once, the first time someone opens a table by hand
async function offerDefault(context) {
  if (isDefault() || context.globalState.get('askedDefault')) return;
  await context.globalState.update('askedDefault', true);
  const pick = await vscode.window.showInformationMessage(
    'Always open .ini files as tables?', 'Yes', 'Not now');
  if (pick === 'Yes') await setDefault(true);
}

function activeUri() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  return input && input.uri ? input.uri : vscode.window.activeTextEditor?.document.uri;
}

class IniTableProvider {
  constructor(context) {
    this.context = context;
  }

  async resolveCustomTextEditor(document, panel) {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.html(panel.webview, mediaRoot);

    const cfg = () => vscode.workspace.getConfiguration('iniTableView');

    // ---- baseline (defaults) comparison ----
    // Per-file choice is kept in workspace state; iniTableView.defaultBaseline applies to every INI.
    // A per-file value of 'none' switches the default off for that file.
    const stateKey = 'baseline:' + document.uri.toString();
    const baselinePath = () => {
      const own = this.context.workspaceState.get(stateKey);
      if (own === 'none') return null;
      return own || cfg().get('defaultBaseline', '') || null;
    };
    let baseCache = { path: null, text: null };
    const loadBaseline = async (p) => {
      if (baseCache.path === p && baseCache.text !== null) return baseCache.text;
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
      baseCache = { path: p, text: Buffer.from(bytes).toString('utf8') };
      return baseCache.text;
    };

    const push = async () => {
      let model;
      let baseline = null;
      try {
        model = parseIni(document.getText());
      } catch (e) {
        model = { sections: [], error: String(e) };
      }
      const bp = baselinePath();
      if (bp && !model.error) {
        try {
          diffModels(model, parseIni(await loadBaseline(bp)), { ignore: cfg().get('diffIgnore', []) });
          baseline = { name: bp.split(/[\\/]/).pop(), path: bp, isDefault: !this.context.workspaceState.get(stateKey) };
        } catch (e) {
          baseline = { error: `Could not read baseline ${bp}: ${e.message || e}` };
        }
      }
      panel.webview.postMessage({
        type: 'model',
        fileName: document.uri.path.split('/').pop(),
        model,
        baseline,
        settings: {
          navPosition: cfg().get('navPosition', 'top'),
          hideEmptySections: cfg().get('hideEmptySections', true),
          navSort: cfg().get('navSort', 'grouped'),
          keyOnly: cfg().get('keyOnly', false),
          keySections: cfg().get('keySections', [])
        }
      });
    };

    // Re-render (debounced) when the underlying text changes, e.g. edited in the text view beside it
    let timer;
    const subs = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        clearTimeout(timer);
        timer = setTimeout(push, 250);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('iniTableView')) push();
      })
    ];
    panel.onDidDispose(() => subs.forEach((s) => s.dispose()));

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          push();
          break;
        case 'reveal': {
          // Jump to the exact line in the raw text, opened beside the table
          const pos = new vscode.Position(msg.line, 0);
          await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.Beside,
            selection: new vscode.Range(pos, pos),
            preserveFocus: false
          });
          break;
        }
        case 'setting':
          await cfg().update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
          break;
        case 'pickBaseline': {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Use as baseline',
            title: 'Choose the default / baseline INI to compare against',
            filters: { 'INI files': ['ini'], 'All files': ['*'] }
          });
          if (!picked || !picked[0]) break;
          const scope = await vscode.window.showQuickPick(
            [
              { label: 'This file only', value: 'file' },
              { label: 'All INI files', description: 'save as iniTableView.defaultBaseline', value: 'all' }
            ],
            { title: 'Compare against this baseline for…' }
          );
          if (!scope) break;
          baseCache = { path: null, text: null };
          if (scope.value === 'all') {
            await cfg().update('defaultBaseline', picked[0].fsPath, vscode.ConfigurationTarget.Global);
            await this.context.workspaceState.update(stateKey, undefined);
          } else {
            await this.context.workspaceState.update(stateKey, picked[0].fsPath);
          }
          push();
          break;
        }
        case 'clearBaseline':
          // turn comparison off for this file (the global default, if any, stays for other files)
          await this.context.workspaceState.update(stateKey, cfg().get('defaultBaseline', '') ? 'none' : undefined);
          push();
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage(`Copied: ${msg.text.slice(0, 60)}`, 2000);
          break;
      }
    });
  }

  html(webview, mediaRoot) {
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>INI Table View</title>
</head>
<body>
  <div id="app" class="nav-top">
    <header id="toolbar">
      <span id="fileName"></span>
      <input id="valueSearch" type="search" placeholder="Search values (e.g. 10.0.0.1, Teams)…" />
      <label class="chk"><input type="checkbox" id="hideEmpty" /> Hide empty</label>
      <label class="chk" title="Wrap long values in wide tables"><input type="checkbox" id="wrapText" /> Wrap text</label>
      <button id="collapseAll" title="Collapse / expand all">⇕ Collapse all</button>
      <button id="togglePos" title="Move section tabs top / right">⇄ Tabs right</button>
      <span id="baselineBox">
        <button id="pickBaseline" title="Compare this file with a default / baseline INI">⇆ Compare with baseline…</button>
        <span id="baselineOn" hidden>
          <span class="bl-name" id="baselineName"></span>
          <select id="diffMode" title="What to show">
            <option value="all">Show all</option>
            <option value="changes">Changes only</option>
          </select>
          <span class="legend"><i class="lg chg"></i>changed <i class="lg add"></i>added <i class="lg rem"></i>removed</span>
          <button id="changeBaseline" title="Pick a different baseline">…</button>
          <button id="clearBaseline" title="Stop comparing">✕</button>
        </span>
      </span>
      <span id="stats"></span>
    </header>
    <nav id="nav">
      <div id="navTools">
        <input id="sectionFilter" type="search" placeholder="Filter tabs…" />
        <select id="navSort" title="Tab order">
          <option value="grouped">★ Key first</option>
          <option value="alpha">A → Z</option>
          <option value="file">File order</option>
        </select>
        <label class="chk" title="Show only key sections"><input type="checkbox" id="keyOnly" /> ★ only</label>
      </div>
      <div id="navList"></div>
    </nav>
    <main id="content"></main>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
