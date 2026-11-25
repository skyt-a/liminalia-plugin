# Liminalia 公式プラグイン

[Liminalia Studio](https://liminalia.skyta.dev/) の「プラグイン」→「公式のプラグイン」から、開いているプロジェクトにインストールできます。一覧とプラグイン本体の取得にはインターネット接続が必要です。インストールしたプラグインはプロジェクトの `plugins/<id>` に保存されます。作品を開き直すと使えます。

| プラグイン | 用途 |
| --- | --- |
| [AI 相談](plugins/ai) | シナリオ執筆中にローカルの Codex・Gemini CLI に相談 |
| [Live2D](plugins/live2d) | Live2D Cubism のモデルを立ち絵に表示 |
| [Spine](plugins/spine) | Spine の骨格を立ち絵に表示 |
| [外出先から接続](plugins/remote-connect) | Cloudflare Access 経由で Studio に接続 |

Live2D と Spine の使い方およびランタイムの入手先は [立ち絵の動き](https://liminalia.skyta.dev/docs/live2d-spine/) を参照してください。

## 開発と配布

Node.js 22 を使います。

```sh
npm ci
npm run typecheck
npm test
npm run build -- v0.1.0
```

各プラグインのバージョンは `plugins/<id>/package.json` で管理します。内容を更新したプラグインのバージョンを上げ、配布用の新しいタグでビルドしてください。生成した `dist/catalog.json` とすべての `dist/*.limplugin.json` を同じ GitHub Release に添付します。Studio が一覧を取得できるよう、成果物を揃えてからリリースを公開してください。

```sh
gh release create v0.1.0 dist/catalog.json dist/*.limplugin.json --draft --title v0.1.0
```

利用条件は [LICENSE](LICENSE) を参照してください。
