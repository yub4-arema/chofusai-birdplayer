# 調布祭 Flappy × Jev

[調布祭マップ](https://www.google.com/search?q=https://www.chofusai.jp/map/)のミニゲームをAI（Jev等）に自動プレイさせる、Manifest V3対応のChrome拡張機能です。

## 主な機能 (v1.4.0-r3)

AIがリアルタイムに `FLAP`（ジャンプ） / `WAIT`（待機）を判断します。画面から読み取ったゲーム状態、通信遅延を補正した現在位置、攻略ルールをAIへ送信します。なお、ゲーム内の移動速度・重力・障害物のランダム生成などの挙動は元のままです。

* **リクエスト間隔の調整（50〜500ms）**
初期値は100msです。設定した間隔は次回スタート時から適用されます。
* **通信遅延（レイテンシ）の自動補正**
プレイ開始前に3回の事前通信で応答時間を計測し、経路全体の遅延に合わせて操作タイミングを調整します。開始後の操作入力は描画を待たずに予定時刻で実行されます（詳細は[検証記録](https://www.google.com/search?q=docs/realtime-benchmark.md)を参照。
* **詳細な診断ログ**
ゲーム画面上の操作欄にある「診断ログ」から、リクエスト・レスポンスの状況、回答の採用・破棄理由、実際の操作履歴を確認でき、実行ログをJSON形式で保存できます（※APIキーやゲーム状態全体などの機密情報は含まれません）。

> **アップデートに関する注意**
> [v1.4.0リリース](https://www.google.com/search?q=https://github.com/yub4-arema/chofusai-birdplayer/releases/tag/v1.4.0)から最新のZIPファイルをダウンロードできます。旧バージョンのZIPをご利用の場合は、最新版に差し替えたうえでゲームページを再読み込みしてください。設定済みの接続先・モデル・APIキー・API上限設定はそのまま引き継がれます（旧方式の[v1.1.0リリース](https://www.google.com/search?q=https://github.com/yub4-arema/chofusai-birdplayer/releases/tag/v1.1.0)も公開を継続しています）。

---

## インストールと開始手順

1. 配布ZIPファイルをダウンロードし、任意のフォルダに解凍します。
2. Chromeで `chrome://extensions` を開き、画面右上の「デベロッパーモード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」をクリックし、解凍したフォルダ内の **`extension` フォルダ** を選択します。
4. [調布祭マップ（ゲームページ）](https://www.google.com/search?q=https://www.chofusai.jp/map/) を開きます（すでに開いている場合はページを再読み込みしてください）。
5. 拡張機能「調布祭 Flappy × Jev」のポップアップを開き、APIキーを入力します。
6. リクエスト間隔を設定し、ゲーム画面上の操作欄で「保存して開始」をクリックします。

※ APIキーは [TypeSafe Console](https://console.typesafe.ai/) から取得してください。キーは接続先URLごとにChrome内に保存されます（空欄のまま保存した場合は設定済みのキーが継続利用されます）。「この接続先の保存済みキーを削除」を押すと、指定した接続先のキーのみ消去できます。なお、キーがWebページ本体や content script へ渡されることはありません。

---

## 詳細仕様と操作方法

### リクエスト頻度と操作

* **リクエスト間隔**: 初期値は100msです（以前設定した値がある場合は保持されます）。なお、リクエスト間隔とAIの応答時間は別物です。たとえば400msかかる応答を70ms間隔にしても応答速度自体は短縮されません。また、開始前の遅延計測通信もAPI利用制限および課金対象に含まれます。
* **開始 / 停止**: ポップアップまたはゲーム上の操作欄から実行できます。キーボードの `Esc` キーでも停止可能です。開始時にスコアは0にリセットされます。
* **API上限数**: 初期値は `0`（無制限）です。1以上の数値を設定すると指定回数でリクエストを停止します。自動再挑戦時もリクエスト数はリセットされません。上限に達すると新しいリクエストの送信を停止します。
* **自動再挑戦**: 初期値はオフです。オンにするとゲームオーバー時に自動で再挑戦ボタンを押します。
* **自動停止条件**: ゲームオーバー（自動再挑戦がオフの場合）、タブの非表示化、ゲーム画面の画面外移動、ウィンドウサイズの変更、画面読み取り失敗、APIエラー。停止時には進行中の通信も即座にキャンセルされます。
* **スコア判定**: グレーの障害物は1点、ゴールドの障害物は3点です。ハイスコアは接続先・モデルごとにサイトの `localStorage` に保存されます。

### 診断ログ機能

ゲーム画面上の操作欄にある「診断ログ」をクリックすると、以下の情報をリアルタイムで確認できます。

* 起動時の通信遅延測定結果
* 通常リクエストの送信・応答時間
* 回答の採用数および破棄理由（応答遅延、FLAP実行後の古いエポック、ゲーム終了など）
* `WAIT` / `FLAP` の実際の実行回数

「更新」ボタンで最新ログを表示し、「JSON保存」で記録中のログを出力できます。画面上には直近200件のイベントが表示されますが、JSON出力時には保持されている全イベントが含まれます。

※ ログはタブ内のメモリ上に直近8回分のみ保持され、ページの再読み込みやタブの閉鎖で消去されます（1回の実行につき最大15,000イベントまで保持し、超えた場合は古い順に削除）。APIキー、リクエスト本文、Canvas画像は一切記録されません。

> **動作にあたって**
> ゲーム画面をブラウザ上に表示させた状態でご利用ください。なお、100点達成は本拡張機能の性能目標値であり、達成を保証するものではありません。

---

## 対応モデルと接続先プロファイル

「接続プロファイル」から使用するモデル・サーバーを選択できます。APIキーは接続先URLごとに個別保存されます。新しい接続先を追加する際はChromeからアクセス許可が求められます。

| プロファイル名 | 接続先URL | 使用モデル | 認証方式 |
| --- | --- | --- | --- |
| TypeSafe Jev | `[https://api.typesafe.ai/v1/systemone](https://api.typesafe.ai/v1/systemone)` | `jev-latest` / `jev-preview` | TypeSafe APIキー |
| Cloudflare Clef | Cloudflare Workers AI REST（Account IDから自動生成） | `clef` | Cloudflare API Token |
| Cloudflare Clef Flash | Cloudflare Workers AI REST（Account IDから自動生成） | `clef-flash` | Cloudflare API Token |
| Liquid AI d1 | `[https://api.liquid.ai/decisions/v1/systemone](https://api.liquid.ai/decisions/v1/systemone)` | `d1` | Liquid APIキー |
| Laya | `[http://127.0.0.1:8000/v1/systemone](http://127.0.0.1:8000/v1/systemone)` | `english` / `multilingual` / `typed-decisions` | 任意（`LAYA_API_KEY` 使用時） |
| Custom System One | 任意の許可済み接続先 | サーバー仕様に準拠 | サーバー仕様に準拠 |

* **Cloudflare**: 32桁の Account ID と API Token を入力してください。モデルに応じた公式URLが自動生成され、`Authorization: Bearer` ヘッダーで送信されます。
* **Liquid d1 / Laya**: System One互換プロファイルとして動作し、`instructions` を文字列に整形して送信します。
* **Laya**: ローカル等で別途サーバーを起動してご利用ください（KevやLocalJevなどの以前のSystem One互換サーバーも Custom プロファイルで接続可能です）。

※ 各サービスの公式ドキュメント:

* [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/) / [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)
* [Liquid AI d1](https://www.liquid.ai/blog/d1-decision-model)
* [Laya HTTP API](https://github.com/NandhaKishorM/laya/blob/main/docs/http-api.md)

---

## 推論と通信の仕組み

ローカル側（Chrome拡張機能）では Canvas の描画観測、位置の外挿計算、リクエスト・レスポンスの時刻管理を行います。「ジャンプする（FLAP）」か「待機する（WAIT）」かの判断自体はすべてモデル側が行います。拡張機能からは障害物の上下の隙間、上昇・下降状態、固定の攻略ルールをモデルへ伝えます。ローカル側でモデルの判定を上書き・差し替えることはありません。

* 最大12件までの並列リクエストに対応しています。
* 応答は予測された適用タイミングに合わせて実行され、リクエスト間隔（最大250ms）を超えて遅延したレスポンスは破棄されます。
* `FLAP` を実行した後は、前の移動軌道に基づく保留中の回答が無効化されます。また、`FLAP` 直後の古い観測データを新しいリクエストに再利用することはありません。
* 適用時刻までに通過する予定の障害物は幾何計算から除外し、次に到達する障害物にフォーカスさせます。

---

## 送信データと権限・セキュリティ

* **送信内容**: ゲームの数値データ（座標等）、簡潔な状態説明、物理パラメーター、通信時間、ルールのみを送信します。画像データ、ページ本文、Cookie、閲覧履歴などは一切送信されません。
* **データ保存**: 設定およびAPIキーは `chrome.storage.local` 内の制限された領域に保存され、同期されません。保存されたキーが設定画面上に再表示されることはありません。
* **権限**: 設定の保存、TypeSafe等の指定APIへの接続、対象ゲームページへの content script の注入、ユーザーが許可した追加接続先へのアクセスのみを使用します。外部スクリプトの動的読み込みはありません。

---

## 開発・動作確認

ビルド作業は不要です。`extension/` フォルダをそのままChromeに読み込んで使用できます。

```sh
node --test tests/*.test.cjs
node --check extension/core.js
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js

```

※ 自動テストでは、各プロファイルの送信フォーマット、認証ヘッダー、レスポンスの正規化をモック環境で検証しています。実際の外部サービスへの接続テストには有効なAPIキーが必要です。詳細は [検証記録](https://www.google.com/search?q=docs/realtime-benchmark.md) を参照してください。

---

## ライセンス

本拡張機能は [MIT License](https://www.google.com/search?q=LICENSE) のもとで公開されています。

※ 元のゲームのコード・画像アセット・AIモデルの重み・APIキーは本リポジトリおよび配布物には含まれません。
