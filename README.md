# screenshot

## 動作環境

- Node.js 18以上
- 推奨: Node.js 20 LTS または22 LTS

TOPページ動画録画:

```bash
npm install
node record_top.js https://hikarina.co.jp/
```

`record_top.js` は `ffmpeg-static` を使用して録画後のMP4を再muxし、
有限のduration、期待する解像度、全フレームのデコード可否を検証します。
検証に失敗した動画は保存せず、DBも更新しません。
