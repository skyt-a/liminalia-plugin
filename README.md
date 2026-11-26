# Liminalia 公式プラグイン

[Liminalia Studio](https://liminalia.skyta.dev/) の「プラグイン」画面（または `lim plugin search` / `lim plugin install`）から、必要な機能だけを選んでプロジェクトに追加できます。インストールしたプラグインはプロジェクトの `plugins/<id>` に保存され、作品を開き直すと有効になります。

## 作品向けプラグイン（ゲーム本体に機能を追加）

| プラグイン | 分類 | 主な用途 |
| --- | --- | --- |
| [探索・図鑑・HUD パック](plugins/std-adventure) | ゲーム進行 | `@investigate`、`@map-choice`、`@codex`、`@hud-button`、`@hud-text` |
| [高度演出・漫画エフェクトパック](plugins/std-fx) | 演出 | `@lighting`、`@particles`、`@speedlines`、`@burst`、`@emote`、`@effect`、`@flipbook` |
| [チャット風・HTML 表現パック](plugins/std-ui-modes) | 演出 | `@chat-open`、`@chat`、`@html`、`@layer-text`、`@motion-text` |
| [シネマティック演出パック](plugins/std-cinematic) | 演出 | `@staff-roll`、`@chapter-card`、`@keyframe`、`@layer-camera`、`@chara-move` |
| [ストア課金・実績・プレゼンス](plugins/store-commerce) | 配信 | `@purchase`、`@achieve`、`@presence`、`@check-update` |
| [Live2D](plugins/live2d) | 立ち絵動き | Live2D Cubism モデルを立ち絵に表示（Cubism Core は別途配置） |
| [Spine](plugins/spine) | 立ち絵動き | Spine 骨格を立ち絵に表示（ランタイムは別途配置） |

## 制作ツールプラグイン（Studio・CLI の専門工程を追加）

| プラグイン | 分類 | 主な用途 |
| --- | --- | --- |
| [AI 相談](plugins/ai) | AI | シナリオ執筆中にローカルの AI エージェントへ相談 |
| [タイムライン編集](plugins/studio-timeline) | 制作画面 | 演出の開始タイミングと長さをドラッグで調整 |
| [ボイス収録・一括管理](plugins/voice-production) | 制作画面 | ボイス一括管理画面、`lim voice-script`、`lim voice-lock` |
| [レビューコメント・校正ツール](plugins/review-collab) | 制作画面 | レビューコメント画面、`lim prose`、`lim script-export` |
| [画面パーツと CSS 編集](plugins/screen-customizer) | 制作画面 | システム画面の HTML/CSS 直接編集、`lim screens` |
| [多言語翻訳ツールキット](plugins/i18n-toolkit) | 制作画面 | 翻訳タブ、プレビュー言語切替、`lim i18n` |
| [変数・ブレークポイントデバッガ](plugins/debug-tools) | 制作画面 | 変数一覧、ブレークポイント、ステップ実行 |
| [外出先から接続](plugins/remote-connect) | 制作画面 | Cloudflare Access 経由で Studio に接続 |
| [TyranoScript 移行・書き戻し](plugins/tyrano-import) | インポート | `lim import`、`lim backport`、`lim new --from-tyrano` |
| [他ツールシナリオ取り込み](plugins/story-import) | インポート | `lim import-ink`、`import-yarn`、`import-renpy`、`import-twine` |
| [PSD 立ち絵パーツ取り込み](plugins/psd-import) | インポート | `lim psd`（PSD/PSB レイヤーからの立ち絵差分生成） |
| [CI 自動テスト・クラッシュ解析](plugins/ci-testing) | 配信 | `lim test`、`lim reach`、`lim playtest`、`lim crash` |
| [Steam・itch.io 配信とパッチ](plugins/publish-stores) | 配信 | `lim publish`、`lim pack`、`lim patch`、`lim update-manifest` |
| [Android・iOS アプリ書き出し](plugins/build-mobile) | 配信 | `lim build android`、`lim build ios` |

Live2D と Spine の使い方およびランタイムの入手先は [立ち絵の動き](https://liminalia.skyta.dev/docs/live2d-spine/) を参照してください。

## 開発と配布

Node.js 22 を使います。

```sh
npm ci
npm run typecheck
npm test
npm run build -- v0.2.0
```

各プラグインのバージョンは `plugins/<id>/package.json` で管理します。生成した `dist/catalog.json` とすべての `dist/*.limplugin.json` を同じ GitHub Release に添付してください。

利用条件は [LICENSE](LICENSE) を参照してください。
