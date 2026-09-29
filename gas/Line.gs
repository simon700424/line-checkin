/**
 * LINE API 呼叫。Channel access token 存在「指令碼屬性」LINE_CHANNEL_ACCESS_TOKEN，
 * 不放在試算表，避免分享試算表時外洩。
 */

function lineToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!t) throw new Error('尚未設定指令碼屬性 LINE_CHANNEL_ACCESS_TOKEN');
  return t;
}

function lineApi_(path, payload) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/' + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + lineToken_() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) console.error('LINE API ' + path + ' ' + code + ': ' + res.getContentText());
  return code === 200;
}

/** 回覆訊息（不計入每月推播則數）。 */
function reply_(replyToken, text) {
  return lineApi_('message/reply', { replyToken: replyToken, messages: [{ type: 'text', text: text }] });
}

/** 主動推播（計入每月則數）。 */
function push_(userId, text) {
  return lineApi_('message/push', { to: userId, messages: [{ type: 'text', text: text }] });
}

function getProfile_(userId) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + lineToken_() },
    muteHttpExceptions: true
  });
  return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : null;
}

/**
 * 驗證 LIFF 傳來的 ID token，回傳 { userId, name }；失敗回傳 null。
 * 這一步讓後端不必相信前端自稱的 userId。
 */
function verifyIdToken_(idToken, channelId) {
  if (!idToken || !channelId) return null;
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: channelId },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  var p = JSON.parse(res.getContentText());
  return { userId: p.sub, name: p.name || '' };
}
