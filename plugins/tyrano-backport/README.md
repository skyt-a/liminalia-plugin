# liminalia-tyrano-backport（TyranoScript への書き戻し）

Liminalia 側で修正した `.lim` の変更差分を、元の TyranoScript（`.ks`）プロジェクトへ書き戻す（`lim backport`）公式プラグインです。
※ TyranoScript からの取り込み（`lim import` / `lim new --from-tyrano`）は本体に標準搭載されています。

## 提供するコマンド

- `lim backport`

## 使い方

Studio の「プラグイン」画面で「TyranoScript への書き戻し」を検索してインストールするか、CLI で次を実行してください。

```sh
lim plugin install tyrano-backport
```
