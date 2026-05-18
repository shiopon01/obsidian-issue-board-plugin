# CLAUDE.md

このファイルは Issue Board プラグインを別セッションで触るときに最低限知っておくべきことをまとめたものです。Obsidian 共通の規約は `AGENTS.md` 側にあります。

## このプラグインは何か

GitHub Projects / obsidian-kanban 風の Issue 管理ビュー。

- **Board ファイル**: frontmatter に `issue-board: true` を持つ `.md` ファイル。これを開くと markdown view ではなく Issue Board view が起動する。
- **Issue**:
  - **File issue**: 1 issue = vault 内の 1 つの `.md` ファイル (frontmatter に `id`, `status`, `priority`, `due` などを持つ)。本文は通常の markdown。
  - **Draft**: board ファイル本文の JSON code block (`%% issue-board:drafts %%` の下) に格納される、ファイル化前のメモ。
- **ビュー**: kanban / list の 2 モード。並び替え・グループ化・フィルタ・DnD・チェックリスト集計・priority・due 着色など。
- 複数 board を同時に持てる。各 board は独立した設定・draft・issue フォルダを持つ。

## ファイル構成

```
src/
  main.ts                       # Plugin lifecycle / view registration / menus / migration / monkey-patch
  types.ts                      # 型定義のすべて
  settings.ts                   # グローバル設定 (defaultTemplate のみ) と SettingTab
  store/
    boardFile.ts                # board .md の parse/serialize、新規 config の自動導出
    fileIssue.ts                # file issue の parse/serialize、ensureFolder
    issueStore.ts               # IssueStore (per-board の中核ロジック)
  ui/
    boardView.ts                # TextFileView。ヘッダ・kanban・list・DnD・popover トリガ全部
    issueModal.ts               # Create/Edit issue モーダル
    viewPopover.ts              # View 設定ポップアップ (独自実装、submenu / 開きっぱなし対応)
    statusModal.ts              # ステータス追加・編集モーダル
  utils/
    checklist.ts                # GFM `- [ ]` / `- [x]` のカウント
    template.ts                 # `{{id}}` `{{title}}` の差し込み
```

## データモデル

### `BoardConfig` (board ファイルの frontmatter)

```ts
{
  issueFolder: string;          // 実体 issue を置くフォルダ
  idPrefix: string;             // "TASK" → TASK-1, TASK-2...
  nextIdNumber: number;         // 次に採番する番号
  statuses: StatusDef[];        // [{ id, name, color? }]
  defaultStatus: string;        // statuses の id
  template: string;             // 新規 issue の body テンプレート
  listView: ListViewSettings;   // groupBy/sortBy/sortDirection/fields/hiddenFields/collapsedGroups
}
```

### `Issue = DraftIssue | FileIssue`

両方とも `kind` discriminator を持つ。共通フィールド:
- `id` (file は採番された `TASK-N`、draft は内部 `draft-<ts>-<rand>`)
- `title`, `status`, `body`, `createdAt`, `updatedAt`, `order`, `due?`, `priority?`
- file のみ `path`

`order` は **float**。DnD 並び替えは「前後の order の中点」を取る fractional indexing で、1 件の書き込みだけで済む。

### `Field` (list ビュー列)

`"id" | "title" | "status" | "priority" | "due" | "created" | "updated" | "checklist"`

`lv.fields` は **全 field を表示順で並べた配列**。`lv.hiddenFields` がそのうち非表示の subset。可視 fields は `fields.filter(f => !hiddenFields.includes(f))` で derive。これでチェックトグルしても位置が動かない。

### `Priority` = `1 | 2 | 3 | 4` (Todoist 流)

- P1 赤 / P2 橙 / P3 青 / P4 (default) はバッジ非表示

## 重要な設計判断 (これは触らないと過去の問題が再発する)

### 1. `WorkspaceLeaf.prototype.setViewState` のモンキーパッチ (`main.ts:installLeafPatch`)

board ファイルを開いたときに markdown view が一瞬出てから差し替わるのを防ぐため、kanban plugin と同じ手法で setViewState をパッチしている。
- 入力 state.type が "markdown" かつファイルが board (frontmatter cache をチェック) なら、type を ISSUE_BOARD_VIEW_TYPE に書き換えてから元の setViewState を呼ぶ
- `this.register(() => proto.setViewState = original)` で plugin 無効化時に確実に元に戻す
- 事後の `file-open` ハンドラはフォールバック用に残してある

代替実装 (file-open だけ) は metadata cache が間に合わないと取りこぼすので必ずパッチ方式を維持すること。

### 2. `ensureFolder` の堅牢化 (`store/fileIssue.ts`)

ユーザーが何度もハマったので 3 段構えになっている:
1. exact-case で `getAbstractFileByPath` を試す
2. それで取れなければ vault root から **case-insensitive で children を辿る** (`findFolderCaseInsensitive`)。macOS/Windows の case-insensitive FS で設定の "issues" と実体 "Issues" のミスマッチに対応するため。
3. なお見つからなければ `createFolder` を投機的に呼び、失敗してもエラーを握り潰して `resolveFolderWithRetry` (10 retry x 20ms) で in-memory index 反映を待つ

`writeNewFileIssue` は `ensureFolder` の返り値 (実フォルダの正しいケース) を使ってファイル path を組み立てること。

### 3. Draft は issue 番号を消費しない

`nextDraftId()` は `draft-<ts>-<rand>`。`promoteDraft()` で初めて `nextFileId()` を消費する。`reconcileNextIdNumber()` も file issue だけを scan する。

### 4. List/Kanban DnD: dragged element 自体を DOM 移動

ドロップ位置のプレビュー要件で、placeholder ではなく **dragged element そのものを** `insertBefore` / `appendChild` で目的位置に動かす。
- `is-dragging` クラスで半透明 + 点線アウトライン → そのままプレビュー
- drop で `sibling から prev/next issue を引き、order を中点計算
- cancel (dragend without drop) では `this.render()` で復元
- 末尾は `.issue-board-add-row` の手前に挿入する (`+ Add item` の後ろに行かないように)

DnD 有効条件は **`sortBy === "manual"`** のみ。groupBy の制約は撤廃済。groupBy=status の場合は **クロスグループドロップで status を変更** する (kanban 列間移動と同じ)。groupBy=kind では kind 変更不可なので異 kind の dragover/drop は無視する。

### 5. Grid alignment は subgrid を使わず固定幅

`FIELD_WIDTH` を全部固定値 (px / 1fr) にして、ヘッダと各行に同じ `gridTemplateColumns` を inline で設定。これで `auto` 由来のズレが起きない。subgrid は試したが padding と互換性が悪く挫折。

### 6. View ボタンは独自 popover (`ui/viewPopover.ts`)

Obsidian の `Menu` は submenu / 開きっぱなしをサポートしないので、`div` + 自前 navigation stack で実装。
- `position: fixed` + `setCssStyles` で位置決め (eslint の `no-static-styles-assignment` 回避のため `element.style.X = ` は禁止)
- outside click + Escape で close
- 内側の commit() は `host.commit()` (view を再 render) → `this.render()` (popover 自身) の順
- drop indicator (popover 内 DnD) は **z-index 20000** にしないと popover (--layer-menu = 9999) に隠れる

### 7. file-explorer 余白の右クリック

`workspace.on("file-menu")` は file/folder クリック時しか発火しない。余白対応のため `registerDomEvent(document, "contextmenu")` で `.workspace-leaf-content[data-type="file-explorer"]` 内で file/folder 以外をクリックしたときに自前 Menu を出している。Obsidian デフォルトの空白メニューを置き換える形なのは妥協済。

### 8. ファイル issue 開くときは常に新タブ

`openIssue()` は `getLeaf("tab")` 固定。board view 自体を上書きしないため。

## Lint で引っかかりやすいルール

`eslint-plugin-obsidianmd` のいくつかが厳しい。

- **`commands/no-plugin-name-in-command-name`**: コマンド名に "Issue board" を入れない。`"Open board"` のように plugin 名抜きで。
- **`ui/sentence-case`**: UI 文字列は sentence case。先頭以外は小文字。ただし `DEFAULT_BRANDS = ["Obsidian", "Markdown", ...]` は例外で大文字必須 (`brands.js` を見れば分かる)。
- **`no-tfile-tfolder-cast`**: `as TFile` 禁止。`instanceof TFile` で narrowing する。
- **`no-static-styles-assignment`**: `element.style.X = value` 禁止。`el.setCssStyles({...})` を使う。grid-template-columns の inline 設定は許される (現状動いている)。
- **`@typescript-eslint/no-this-alias`**: `const self = this` 禁止。必要な field だけ outer scope から捕まえる (`const app = this.app`)。
- **`@typescript-eslint/no-floating-promises`**: 戻り値を捨てるなら `void` 接頭辞か `.catch()` を付ける。
- **`@typescript-eslint/no-unsafe-*`**: `parseYaml` の戻り値は `as Record<string, unknown>` でアノテートしてから触る。

## ビルド / Lint

```
npm run build   # tsc -noEmit -skipLibCheck && esbuild → main.js
npm run lint    # eslint .
```

両方クリーンで通すこと。`main.js` は plugin folder 直下に出力され、Obsidian reload で反映。

## マイグレーション

旧バージョン (board ファイル化前) の `data.json` に `drafts` / `issueFolder` / `idPrefix` 等がある場合、初回起動時に **`Issue Board (migrated).md` を vault root に作成**して中身を移し、`data.json` には `defaultTemplate` と `_migrated: true` だけ残す。`main.ts:maybeMigrateLegacy` 参照。

## よくある追加要望と実装ポイント

| 要望 | どこ |
| --- | --- |
| 新しい field を追加 | `types.ts` の `Field` / `ALL_FIELDS` / `DEFAULT_VISIBLE_FIELDS`、`boardView.ts` の `FIELD_LABELS` / `FIELD_SORT_KEY` / `FIELD_WIDTH` / `renderRowCell`、`viewPopover.ts` の `FIELD_LABELS` |
| 新しい sort key | `types.ts` の `SortBy`、`boardView.ts` の `sortIssues` switch、`viewPopover.ts` の `SORT_OPTIONS`、対応する Field の `FIELD_SORT_KEY` |
| 新しい group by | `types.ts` の `GroupBy`、`boardView.ts` の `groupIssues`、`viewPopover.ts` の `GROUP_OPTIONS`、`prefillForGroup` も忘れずに |
| Issue に新フィールド (priority のような) | `types.ts` の DraftIssue/FileIssue、`store/fileIssue.ts` の frontmatter parse、`store/issueStore.ts` の create / updateFileIssue / writeNewFileIssue / promoteDraft、`ui/issueModal.ts` 両モーダル |

新規追加時は build と lint を毎回通すこと。型エラーが連鎖しやすい。
