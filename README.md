# 調布祭 Flappy × Jev

https://www.chofusai.jp/map/ の準備中ページにあるミニゲームを自動でプレイする、Chrome用のManifest V3拡張機能です。

**Jevがゲーム状態ごとに「今クリック」または「待機」を選び、拡張機能はその判断どおりに操作します。** Canvasのピクセルから赤い丸と障害物を読み取り、設定したAPIへ数値状態を送ります。Jevモードではローカルのタイミング制御を使いません。ゲームの物理・当たり判定・得点は変更しません。

## インストール

1. [GitHub Releases](https://github.com/yub4-arema/chofusai-birdplayer/releases/latest)から配布ZIPをダウンロードし、展開します。
2. Chromeで `chrome://extensions` を開き、右上の「デベロッパーモード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」を押します。
4. 展開したフォルダの中の **`extension` フォルダ**（`manifest.json` が入っているフォルダ）を選びます。
5. [ゲームページ](https://www.chofusai.jp/map/)を開きます。すでに開いている場合は再読み込みしてください。

## APIキーを入れる場所

1. Chrome右上の拡張機能メニューから **「調布祭 Flappy × Jev」** を開きます。
2. **「APIキー」** 欄にキーを入力します。キー不要のサーバーでは空欄で使えます。
3. ゲームのタブを開いた状態で **「保存して開始」** を押します。

キーの取得先は [TypeSafe Console](https://console.typesafe.ai/) です。チャットにキーを貼る必要はありません。

キーは **接続先URLごとに `chrome.storage.local` へ保存**します。Chromeを終了しても、モデルや接続先を切り替えても残り、元の接続先へ戻すとそのキーを使います。空欄で保存すると、その接続先の保存済みキーを維持します。「この接続先の保存済みキーを削除」で、選択したURLのキーだけを消せます。旧版のセッション保存キーが残っている場合は初回起動時に移行します。

Chromeのローカル保存を使い、クラウド同期はしません。保存領域へのアクセスを `TRUSTED_CONTEXTS` に制限し、ページのスクリプト・content scriptへキーを渡しません。設定画面にも保存済みキーの値を再表示せず、別の接続先のキーを流用しません。

## モデルを切り替える

**「接続先URL」と「モデルID」** を変えて「保存して開始」を押すだけです。開始時にゲームをリセットし、スコア0からプレイします。ベストスコアは接続先とモデルIDごとに保存します。元のゲームではグレーの障害物が1点、ゴールドが3点なので、スコアは通過個数そのものではありません。

一次資料で共通API形式を確認した設定例:

| サービス | 接続先URL | モデルIDの例 |
|---|---|---|
| TypeSafe | `https://api.typesafe.ai/v1/systemone` | `jev-latest` / `jev-preview` |
| [Kev](https://github.com/jaredpalmer/kev) | `http://127.0.0.1:8009/v1/systemone` | `kev-latest` |
| [Laya](https://github.com/NandhaKishorM/laya) | `http://127.0.0.1:8000/v1/systemone` | `english` / `multilingual` / `typed-decisions` |
| [LocalJev](https://github.com/githubnext/localjev) | `http://127.0.0.1:8080/v1/systemone` | `jev-latest` |
| [Simple Jev](https://github.com/featherless-ai/simple-jev) のローカルサーバー | `http://127.0.0.1:8000/v1/classifier` | 実際にロードしたモデルID |

ローカルモデルのサーバーは、それぞれの資料に従って別途起動してください。拡張機能はモデルのダウンロードや起動は行いません。KevやLocalJevのエイリアスは、そのサーバーがロードしている重みを指します。TypeSafeの公式一覧APIでは `jev-latest` と `jev-preview` を確認しました。

リクエストは共通の `{ model, state, questions }` 形式です。`questions.action` の `Choice` で `click` または `wait` を選び、`answers.action.choice` の選択をゲーム操作に使います。接続先にはHTTPS、または `localhost` / `127.0.0.1` のHTTP URLを指定できます。新しい接続先の保存時にChromeがアクセス許可を求めます。OpenAI Chat Completionsなど、異なるAPI形式には直接対応していません。

## 操作と制限

- **開始／停止**: 拡張機能のポップアップ、またはゲームの上に追加される操作欄から実行します。`Esc` でも停止できます。
- **Jevの操作判断**: 応答後160ms以上の間隔で状態を送り、Jevには `click` / `wait` だけを判定させます。`click` の応答が届いた時点で1回クリックし、`wait` なら次の判断まで入力しません。プレイヤーの半径込みで安全な中心Y座標の範囲、上昇／下降方向、応答時点の推定位置を送ります。クリックは速度を上向きの値にリセットするため、上昇中の再クリックは上昇を延ばします。プレイヤーの上端が0未満、または下端が画面高を超えるとゲームオーバーです。900msを超えた古い応答は実行せず停止します。Jevの操作・信頼度・モデル・API回数・応答時間をページに表示します。
- **ローカルテスト**: APIキーなしで動作確認できます。Jevは使わず、中央を目標にするローカル制御を使います。表示でもAPI未使用を明示します。
- **API呼び出し上限**: 初期値200回、設定範囲1～1000回。上限は「開始」1回ごとに適用し、自動再挑戦でもリセットしません。上限の判断を適用した後に停止します。Jevモードは障害物ごとに1回ではなく、繰り返し操作判断を行うため、上限に達するまでの時間が短くなることがあります。
- **自動再挑戦**: 初期状態はオフ。オンの場合、ゲームオーバー後に通常の再挑戦ボタンを押します。
- **安全な停止**: タブが非表示になった場合、ゲームが画面外に出た場合、画面がリサイズされた場合、読み取りに失敗した場合、APIエラーの場合に停止します。停止後のAPI応答は操作に使用しません。
- 得点はゲーム自身の表示から読みます。ベストスコアはこのブラウザ・サイト内で接続先とモデルIDごとに保存します。

画面を表示したまま使ってください。ゲームはランダムな障害物が続くため、必ず無限に生存することは保証しません。ゲームの描画や物理がサイト側で変更された場合は調整が必要です。サイト確認日: 2026-10-01。

## Jevについて調べた内容

JevはTypeSafe AIのSystem Oneモデルです。定義済みの選択肢を選ぶ `Choice`、スコアを返す `Score`、確率を返す `Noul` が提供されています。今回は `Choice` を使います。

公式JavaScript SDKのソースで以下の契約を確認しています。

- エンドポイント: `POST https://api.typesafe.ai/v1/systemone`
- 認証: `Authorization: Bearer <APIキー>`
- モデル初期値: `jev-latest`。バージョン固定する場合は設定欄に有効な `jev-...` のモデル名を入力します。
- リクエスト: `{ model, state, questions: { action: { type: "choice", instructions, criteria } } }`。`state.vertical_bounds` に上下の壁と安全なプレイヤー中心Y範囲を、`vertical_direction` に速度符号から求めた上昇／下降方向を含めます。応答時にクリックした場合の推定上昇頂点と上壁までの余裕も送ります。
- 選択肢: `click`（応答を受け取ったら1回クリック）または `wait`（次の観測まで入力なし）。
- 応答: `answers.action.choice` と `answers.action.confidence` を検証して使用します。

参考:

- [TypeSafe AI](https://typesafe.ai/)
- [公式ドキュメント](https://docs.typesafe.ai/)
- [公式JavaScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js)
- [API実装](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/client.ts)
- [質問・応答の型定義](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/types.ts)

## 送信内容と権限

選択したAPIへ送るのは、ゲーム画面の寸法、上下の壁のY座標と安全な中心Y範囲、丸の座標・半径・推定速度と上昇／下降方向、重力・浮上速度、直近のクリックからの経過時間、次とその次の障害物の座標・隙間、および応答時点の推定位置だけです。スクリーンショット、ページ本文、Cookie、閲覧履歴は送信しません。API料金・利用枠は接続先の契約に従います。

権限は設定保存用の `storage`、TypeSafe APIへの接続、指定ゲームページへのcontent scriptです。追加の接続先は `optional_host_permissions` とし、使うサイトだけを保存操作時に許可します。外部ライブラリや遠隔コード読み込みはありません。

## 開発

ビルドは不要です。`extension/` をそのまま読み込みます。

```sh
node --test tests/background.test.cjs
node --check extension/core.js
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js
```

`core.js` はCanvas読み取り・API形式、`content.js` はJev判断の実行とページ内UI、`background.js` はキー管理とAPI通信、`popup.*` は設定画面です。

v1.2.2では開始直後の上昇速度を、開始クリックからの経過時間とゲーム物理から推定します。再クリックが上昇速度をリセットすること、応答時にクリックした場合の推定上昇頂点と上壁までの余裕もJevへ伝えます。この修正後の自動テスト、構文チェック、Chromeでの実ゲーム試行と実API接続は未確認です。

### v1.2.1の変更

v1.2.1では、ゲームオーバーとなる上下の壁の境界と、上昇／下降の方向をJevに明示しました。修正後の自動テストとChrome実ゲーム試行は未確認です。

### v1.2.0の検証記録

v1.2.0では自動テスト9件と4ファイルの構文チェックを実行しました。Chromeへの読み込み後の実ゲーム試行と実API接続は未確認です。

### v1.1.0の検証記録

v1.1.0では、Jevが通過位置を選びローカル制御がクリックする方式で、30秒間に22点を獲得した試行がありました。この結果は旧方式の記録で、クリック判断をJevに移した本バージョンの性能を示すものではありません。

設定保存、開始・停止、Escでの停止、APIエラー表示（HTTP 401の模擬応答）、スマホ幅の表示、API未使用のローカルテストもv1.1.0で確認しました。ブラウザでの実行時エラーは検出されませんでした。キーの保護、API呼び出し上限、並行問い合わせの抑止、停止時の通信キャンセル、不正応答の拒否を確認する9件の自動テストも通過しています。検証後、キーを含む一時ファイルは削除しています。

当時の検証用Chromiumでは、管理ポリシーにより未パッケージ拡張機能のインストールが禁止されていたため、拡張機能を丸ごとインストールした確認はできていません。ブラウザ内では同じcontent scriptとpopupのコードにテスト用のChrome APIを接続し、backgroundのコードは別のJavaScript実行環境で検証しました。

Browserプラグインが利用できなかったため、PlaywrightとChromium 151で検証しました。デスクトップは1100×820、スマホ幅は390×844です。実Jev試験では、環境のネットワークプロキシを使うため、backgroundのAPIリクエストをテスト環境側でcurlに中継しました。配布コードは拡張機能のサービスワーカーから通常の `fetch` で直接接続します。

1.1版では、模擬System One APIでTypeSafeから別の接続先・モデルへ切り替える操作、キーの接続先別保存、別サーバーへのキー送信防止、モデルごとのベストスコア、開始時のスコアリセットを確認しています。Kev・Laya・LocalJevの実際の重みをこの環境で起動した検証はしていません。

## ライセンス

拡張機能のソースコードは [MIT License](LICENSE) で公開しています。ゲームサイトのソースコード・画像・モデルの重みは配布物に含みません。
