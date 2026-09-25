# Google 登入與 Sheets 連線設定

目前 UI、Node 後端及 Apps Script 同步程式已完成初版，尚未配置正式 Google 憑證或部署 Apps Script。正式 Google 登入、Drive 上傳及 Sheets 寫入仍須實機驗收。

管理者：jack82342005@gmail.com。先確認這個帳號對目標 Sheets 有編輯權限。

## 1. 建立 Google 登入

1. 以管理者帳號前往 https://console.cloud.google.com/projectcreate ，建立「案款記帳」專案。
2. 前往 Google Auth Platform。完成 Branding，應用程式名稱填「案款記帳」，支援信箱及聯絡信箱填管理者信箱。
3. Gmail 帳號的 Audience 選 External。開發期間保持 Testing，將管理者和試用同事加入測試名單。
4. Data Access 僅需 openid、email、profile。員工登入不要求讀寫整個 Drive。
5. Clients → Create client → Web application。
6. 本機驗收的 Authorized redirect URI 填 `http://localhost:5188/auth/google/callback`。正式主機就緒後另加 `https://正式網域/auth/google/callback`。兩者皆須完全相符。
7. 下載 OAuth JSON，放在本機不公開位置。不要放入 GitHub，不要貼到聊天裡。
8. 將 Client ID、Client secret 填入網站後端 `.env` 對應欄位。正式主機改填該主機的秘密變數。

本機正式模式請從 `http://localhost:5188/` 進入，避免與 127.0.0.1 的 Cookie、來源驗證混用。

## 2. 建立照片與 Sheets 同步服務

1. 管理者在 Google Drive 建立「案款收據」資料夾，保留限制存取。不開放任何知道連結的人。
2. 到 https://script.google.com/ 建立獨立 Apps Script，貼上 `google-apps-script/Code.gs`。
3. 顯示並更新 `appsscript.json`，內容取自同名檔案。
4. 專案設定 → 指令碼屬性，加入：
   - `SPREADSHEET_ID`：`1MhyTt-AQr3aeP3NzcIZVftHaFr3DCxQSDPQy5BNtfBM`
   - `RECEIPT_FOLDER_ID`：剛建立的資料夾 ID。
   - `BRIDGE_SECRET`：至少 32 字元的隨機密鑰，需與網站後端相同。
5. 密鑰在本機產生：`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。僅填入兩邊的秘密設定，不傳給前端。
6. 部署 → 新增部署 → 網頁應用程式。執行身分選管理者，存取選「任何人」。端點雖接受連線，但程式會拒絕沒有正確簽章的要求。部署授權必須由帳本管理者完成。
7. 將 `/exec` 結尾網址填入後端 `APPS_SCRIPT_URL`，將相同密鑰填入 `BRIDGE_SECRET`。

腳本會在第一次正式同步時建立隱藏的 `_網站交易索引` 和 `收據相簿`，並在現有案件頁第 13 列起填 A:J。保留原本 K:M 公式與上方儀錶板。

收據先存至私人 Drive 資料夾，再以圖片資料直接嵌入「收據相簿」，不用公開圖片或暫時性 IMAGE 連結。案件頁 H 欄留 Drive 原始檔連結。相簿為固定照片排列，請不要手動排序相簿。

## 3. 啟動與驗收

Node.js 24 以上。複製 `.env.example` 為 `.env`，填完設定後執行：

```text
npm ci
npm test
npm start
```

`APP_MODE=live` 會關閉示範入口並啟用 Google 登入。未填憑證時不提供假登入。

管理者先登入並設定暱稱。進「暱稱與設定」，加入同事 Google 信箱。目前核准成員能查看並代記公司案件，公司給款限管理者。登入名單與款項姓名名單分開，不會因改暱稱改動歷史款項歸屬。

正式放行前，先以獨立測試案驗收：本人記帳、代同事記帳、兩張照片、補件、重試不重複、Sheets 表格排序後照片仍對應、非名單帳號拒絕，以及公司給款限管理者。驗收後再填正式帳。

## 4. GitHub 與正式主機

GitHub 保存整份程式。正式版需要執行 Node 後端及保留 `data/app.sqlite` 的主機，不能僅靠 GitHub Pages。靜態 Sites 試用連結仍是示範版，不是 Google 正式登入站。

主機需 HTTPS、持久磁碟、秘密變數與定期備份。單一 Node 執行個體搭配 SQLite。把 `PUBLIC_ORIGIN` 設為正式網址，`HOST=0.0.0.0`。多人寫入 Sheets 由 Apps Script 鎖定序列處理。

同事的收據檔權限由後端驗證後取圖，不要求把 Drive 資料夾公開。n8n 不在這個流程的必要項目中，日後要通知或排程再另接。

官方文件：
- OAuth 網頁伺服器流程：https://developers.google.com/identity/protocols/oauth2/web-server
- 建立憑證：https://developers.google.com/workspace/guides/create-credentials
- Apps Script 網頁部署：https://developers.google.com/apps-script/guides/web
- 圖片 Blob 嵌入：https://developers.google.com/apps-script/reference/spreadsheet/sheet#insertImage(BlobSource,Integer,Integer)
