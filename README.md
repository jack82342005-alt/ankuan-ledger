# 案款手機記帳

手機優先的公司案件記帳介面。款項當事人與登入登記者分開，每人每案獨立計算。

## 目前交付

- 手機與電腦版 UI、自訂暱稱、代同事記帳、同事名單、公司給款。
- 每筆最多五張收據、前端壓縮、預覽、移除及事後補件。
- Google OAuth 網頁後端、PKCE、nonce、ID token 驗證、HttpOnly 登入 Cookie。
- 管理者核准的登入名單，核准成員能查看與代記公司案件，公司給款限管理者。
- 帶簽章的 Apps Script 同步端點、鎖定寫入、交易編號防重、私人 Drive 收據與 Sheets 內嵌相簿。

## 實際狀態

2026-09-26：本機正式模式已完成管理者 Google 登入，並讀取正式 Sheets 的 2 個案件、2 位款項人員與 7 筆紀錄。

獨立私人驗收副本已通過帶簽章寫入、款項人與登記者分離、Drive JPEG 保存、Sheets 收據相簿內嵌圖片、照片讀回及相同交易重送不重複。測試紀錄未寫入正式帳本，連線已恢復正式帳本。

公開 Sites 試用網址仍為本機示範資料模式，尚未部署正式 Node 主機或推送公司 GitHub。手機實機拍照、Sheets 原生排序後補件，以及完整網站表單寫入驗收仍待完成。

詳細設定見 GOOGLE-SETUP.md。先由管理者建立 Google Cloud OAuth 網頁用戶端，再部署 Apps Script。下載的 OAuth JSON 不提交 GitHub。

## 本機

Node 24 以上。npm ci、npm test、npm start。預設為示範模式。

要試正式連線，將 .env.example 複製為 .env 並填入設定。APP_MODE=live 會關閉示範登入，沒有憑證時明確停用 Google 登入。

## 結構

- dist/：靜態 UI，單獨託管時為示範版。
- server/：Google 登入、權限、個人暱稱、Apps Script 安全串接。
- google-apps-script/：Sheets 與 Drive 同步程式。
- tests/：身分分離、金額、簽章、照片驗證與重試防重測試。
- Dockerfile：正式 Node 主機部署入口，/app/data 必須掛持久磁碟。

免登入版由 GitHub Pages 發布靜態網頁，資料經 Apps Script 寫入 Sheets，照片存入私人 Drive 資料夾。完整網址的井字號後方帶有共用通行碼，通行碼不寫入 GitHub。n8n 不是必要依賴。

## 資料約定

暱稱綁 Google sub，不作帳務人員的主鍵。人員有穩定 ID。交易身分與登記者寫入日期儲存格的附註，避免放在表格外的固定欄位後，因表格排序導致錯配。Sheets 直接填入的舊紀錄仍能讀取，舊紀錄補照片先由管理者在 Sheets 處理。

圖片採私人 Drive 檔案及 Sheets Blob 嵌入，不用暫時性 IMAGE 連結。相簿為固定照片排列，不要手動排序相簿。初版不提供已核准交易的刪除、更正或完整審核工作台。
