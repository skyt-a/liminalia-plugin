# 外出先から Studio に接続する（任意プラグイン）

Studio の「プラグイン」→「公式のプラグイン」で「外出先から接続」をインストールする。作品を開き直し、「プラグイン」→「外出先から接続」から利用する。

Cloudflare Access で利用者を限定した専用ホスト名、ローカル管理の Cloudflare Tunnel、`cloudflared` が必要。`~/.liminalia-studio/remote.json` に `hostname`、`tunnel`、`credentialsFile`、`team`、`audience` を設定する。認証ファイルは作品フォルダには入れず、本人以外に読ませない。Cloudflare 側の Access ポリシーと cloudflared の JWT 検証が必要で、トンネルを停止すると接続できなくなる。

Studio と作品を開いた状態で開始し、Mac の電源とネットワークを保つ。Cloudflare のプランと利用状況によっては費用が生じる場合がある。
