# 調布祭 Flappy × Jev

[調布祭マップ](https://www.chofusai.jp/map/)のミニゲームをJevにプレイさせる、Chrome用のManifest V3拡張機能です。

## v1.4.0-r3（更新）

Jevがリアルタイムに `FLAP` / `WAIT` を選びます。画面から読み取った状態、通信時間を補正した位置、短い攻略条件をJevへ渡します。ゲームの速度・重力・ランダムな障害物は元のままです。

- **要求間隔を50〜500msで調節できます。初期値は100msです。** 保存した間隔は次の開始から適用します。
- 開始前に3回の実通信で応答時間を測定し、通信経路全体の遅延に合わせます。開始後の入力は描画を待たず予定時刻に実行します。詳しい比較と限界は[検証記録](docs/realtime-benchmark.md)にあります。
- **目標得点の設定と、得点による自動停止はありません。** 得点を伸ばす通常プレイです。
- ゲーム上の「診断ログ」から、要求・応答・回答の採用／破棄理由・実際に反映した操作を確認し、選んだ実行をJSONで保存できます。ログにはAPIキーや送信したゲーム状態全体を含めません。

[v1.4.0リリース](https://github.com/yub4-arema/chofusai-birdplayer/releases/tag/v1.4.0)から配布ZIPを取得できます。v1.4.0は同じ版番号で本実装へ更新しています。旧ZIPを使っている場合は新版へ入れ替え、ゲームページを再読み込みしてください。以前の接続先・モデル・APIキー・API上限設定は保持します。旧方式の[v1.1.0リリース](https://github.com/yub4-arema/chofusai-birdplayer/releases/tag/v1.1.0)も維持しています。

## インストールと開始

1. 配布ZIPを展開します。
2. Chromeで `chrome://extensions` を開き、「デベロッパーモード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」で、展開した中の **`extension` フォルダ**を選びます。
4. [ゲームページ](https://www.chofusai.jp/map/)を開きます。すでに開いている場合は再読み込みします。
5. 拡張機能「調布祭 Flappy × Jev」のポップアップを開き、APIキーを入力します。
6. 要求間隔を設定し、ゲームのタブで「保存して開始」を押します。

キーの取得先は[TypeSafe Console](https://console.typesafe.ai/)です。キーは接続先URLごとにChrome内へ保存し、空欄で保存すれば保存済みのキーを使います。「この接続先の保存済みキーを削除」で選択した接続先のキーだけを消せます。ページやcontent scriptにはキーを渡しません。

## 頻度と操作

100msを初期値にしました。保存済みの間隔は保持するため、更新後も70msなどの設定が残ります。比較と同じ条件を試す場合は100msを指定してください。要求間隔と応答時間は別で、400msの応答を70ms間隔の要求で短縮することはできません。開始前の測定もAPI上限と料金に含まれます。
- **開始／停止**：ポップアップ、またはゲーム上の操作欄から使います。`Esc` でも停止できます。開始で得点を0へ戻します。
- **API上限**：初期値0（無制限）。0で無制限、1以上で任意の回数を指定できます。保存済みの1000回などは保持するため、制限をなくすには0を保存してください。1回の開始に適用し、自動再挑戦でもリセットしません。上限後は新しい要求を送りません。
- **自動再挑戦**：初期値はオフ。オンならゲーム終了後に元ゲームの再挑戦ボタンを押します。
- **停止条件**：ゲーム終了（自動再挑戦がオフの場合）、タブの非表示、ゲームが画面外、画面サイズ変更、読み取り失敗、APIエラー。停止時は進行中の通信をキャンセルします。
- **表示得点**：グレーの障害物は1点、ゴールドは3点です。ベストは接続先・モデルごとにサイトのlocalStorageへ保存します。

### 診断ログ

ゲーム上の操作欄にある「診断ログ」を押すと、起動時の通信測定、通常要求の送信・応答時間、回答の採用数、破棄理由（遅延・FLAP後の旧epoch・ゲーム終了など）、WAIT/FLAPの実行数を確認できます。「更新」で最新状態を表示し、「JSON保存」で選択中の実行を保存します。イベント一覧は新しい200件を表示し、JSONには保持中の全イベントを含めます。

ログはタブ内のメモリに直近8回分だけ保持し、ページ再読み込みやタブを閉じると消去します。各実行は最大15,000イベントまで保持し、それを超えた場合は古いイベントから削除します。APIキー、リクエスト本文、Canvas画像は記録しません。診断表示はボタンを押した時だけ描画するため、記録中に一覧を連続更新しません。

ゲームを画面に表示したまま使ってください。100点は性能向上の目安で、達成はまだ確認できていません。

## モデルと接続先

「接続プロファイル」から Jev / Cloudflare Clef / Clef Flash / Liquid d1 / Laya / Custom System One を選びます。キーは接続先URLごとに保存され、切り替えても混ざりません。追加の接続先を保存する際はChromeがアクセス許可を求めます。

| プロファイル | 接続先 | モデル | 認証 |
|---|---|---|---|
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` | `jev-latest` / `jev-preview` | TypeSafe APIキー |
| Cloudflare Clef | Cloudflare公式 Workers AI REST（Account IDから生成） | `clef` | Cloudflare API Token |
| Cloudflare Clef Flash | Cloudflare公式 Workers AI REST（Account IDから生成） | `clef-flash` | Cloudflare API Token |
| Liquid AI d1 | `https://api.liquid.ai/decisions/v1/systemone` | `d1` | Liquid APIキー |
| Laya | `http://127.0.0.1:8000/v1/systemone` | `english` / `multilingual` / `typed-decisions` | 任意（`LAYA_API_KEY` 使用時） |
| Custom System One | 任意の許可済み接続先 | サーバーに合わせる | 接続先に合わせる |

Cloudflareではアカウントの32桁 Account ID とAPI Tokenを入力します。拡張機能は選択中のClefモデルに対応する公式URLを生成し、`Authorization: Bearer` で送信します。Liquid d1とLayaはSystem One互換の標準プロファイルで `instructions` を文字列に整形します。既存Jevプロファイルのリクエスト形式は維持しています。

Layaサーバーは別途起動してください。KevやLocalJevなど以前の任意System OneサーバーもCustomで接続できます。外部APIへの実ネットワーク検証はAPIキーが必要なため実施していません。モックテストの成功は実サービスへの接続確認を意味しません。

公式資料: [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/)、[Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)、[Liquid AI d1](https://www.liquid.ai/blog/d1-decision-model)、[Laya HTTP API](https://github.com/NandhaKishorM/laya/blob/main/docs/http-api.md)。

## 判断と通信

ローカル側はCanvas観測、位置の外挿、要求・応答の時刻管理を行います。クリックするか待つかはJevだけが選びます。Jevへ隙間の上下半分、上昇・下降などの観測と固定の攻略条件を渡します。ローカルで回答を差し替える処理はありません。

最大12件まで並列要求します。回答は予測した適用時刻に実行し、要求間隔（最大250ms）を超えて遅れた回答は破棄します。FLAP後は前の軌道に基づく保留回答を無効化します。FLAP直後の古い観測を新しい要求に再利用しません。適用時刻までに通過済みになる障害物は外挿した幾何から除き、見えている次の障害物へ切り替えます。

## 送信内容と権限

APIへ送るのはゲームの数値状態、短い状態説明、物理・通信時間・ルールです。画像、ページ本文、Cookie、閲覧履歴は送りません。API料金は接続先の契約に従います。

設定とキーは `chrome.storage.local` に保存し、同期しません。保存領域を `TRUSTED_CONTEXTS` に制限し、保存済みキーの値を設定画面へ再表示しません。権限は設定保存、TypeSafeへの接続、対象ゲームのcontent script、選択した追加接続先です。遠隔コードの読み込みはありません。

## 開発・確認

ビルドは不要です。`extension/` をそのまま読み込みます。

```sh
node --test tests/*.test.cjs
node --check extension/core.js
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js
```

自動テストでは各接続プロファイルの送信形式、認証ヘッダー、Cloudflareレスポンスの正規化をモックで確認します。実サービスの接続には各サービスの有効なキーが必要です。実Chrome上での今回の描画確認は未実施です。詳細は[検証記録](docs/realtime-benchmark.md)を参照してください。

`tools/summarize-logs.mjs` と過去の診断資料は旧版の保存済みログ向けです。現在の診断ログはこのページの実行中メモリに保持し、JSON出力はユーザーが操作した時だけ行います。

## ライセンス

拡張機能は[MIT License](LICENSE)です。元ゲームのコード・画像・モデルの重み・APIキーは配布物に含みません。
