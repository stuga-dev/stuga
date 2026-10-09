# Translation glossary

The one source of consistency for the interface catalogs in `messages/<language>/*.json`. Every
term has exactly one rendering per language. Use it even where another word would also be correct.
For a term not listed here, follow the nearest listed term and add a row in the same change.

Languages: `zh-Hans` 简体中文 · `zh-Hant` 繁體中文 (Taiwan) · `ja` 日本語 · `ko` 한국어 · `de` Deutsch ·
`fr` Français · `es` Español (Spain, neutral) · `pt-BR` Português (Brasil).

## Style

### All languages

- **Keep it as terse as the English.** A heading and one short line. Add no filler, politeness
  padding or explanation that the English lacks, and never add copy listing what Stuga lacks.
- **Write the ICU parts exactly as they appear in English.** Keep argument names (`{name}`,
  `{count}`), `{count, number}`, plural and select keywords, `#`, and rich-text tags (`<link>…</link>`,
  `<b>…</b>`) unchanged. Translate the text inside branches and tags, and move a whole argument or tag
  wherever the grammar needs it. Never split a sentence into pieces or join pieces together. Translate
  every `select` branch in full, with its own gender and number agreement. Keep `=0` and `=1`
  branches where English has them, and add none. `catalog.test.ts` checks that each message has the
  same arguments and tags as the English.
- **Never use the straight apostrophe `'`.** ICU reads it as a quote and silently drops text. Use
  the typographic apostrophe `’` everywhere (`l’IA`, `geht’s`), and never escape anything with `''`.
- **Use `…` (U+2026, one character) for an ellipsis, never `...`.** Keep it on any label that ends
  in one: `Rename…` means a dialog follows, and `Loading…` means something is in progress. CJK uses
  the same single `…`, not `……`.
- **Plural categories.** Write `other` in every plural, plus the categories listed for the language:

  | Language | Categories | Example |
  |---|---|---|
  | zh-Hans, zh-Hant, ja, ko | `other` only | `{count, plural, other {# 个文档}}` |
  | de | `one`, `other` | `{count, plural, one {# Dokument} other {# Dokumente}}` |
  | fr | `one` (0 and 1), `many`, `other` | `{count, plural, one {# document} many {# documents} other {# documents}}` |
  | es | `one`, `many`, `other` | `{count, plural, one {# documento} many {# documentos} other {# documentos}}` |
  | pt-BR | `one` (0 and 1), `many`, `other` | `{count, plural, one {# documento} many {# documentos} other {# documentos}}` |

  `many` covers exact millions. Copy the `other` text into it.
- **Leave numbers, dates, times and sizes to `Intl`.** Never write a date format, decimal separator
  or digit grouping into a message.
- **Stuga’s own menu paths** (`Settings → Your AI agents`) use the translated labels from this file,
  joined with ` → `. Menu paths in other apps (Claude, Antigravity, macOS) stay in English verbatim
  and in the language’s quotation marks. Stuga’s Mac menu-bar app is translated too: its items use
  the rows under “Mac menu bar” below, identically in the web app and the Mac app.
- **Quoting a name.** English `“{name}”` becomes zh-Hans `“{name}”`, zh-Hant `「{name}」`,
  ja `「{name}」`, ko `“{name}”`, de `„{name}“`, fr `« {name} »`, es `“{name}”` and
  pt-BR `“{name}”`.
- **The em dash ` — `.** de, fr, es and pt-BR use a spaced en dash ` – `. zh-Hans and zh-Hant use
  `——` with no spaces. ja and ko split the line into two sentences instead.

### zh-Hans

- Address the reader as 你, never 您. Use 请 only where the English says “please”.
- Use full-width punctuation `，。：；？！（）“”‘’`. Put a half-width space between Han characters and
  Latin letters, digits or a placeholder (`已删除 {count} 个文档`, `AI 编辑`), but no space next to
  full-width punctuation.
- Buttons are verbs (保存, 删除) and headings are noun phrases. Use 个 as the default measure word:
  `# 个文档`, `# 行`, `# 个字符`.

### zh-Hant

- Use Taiwan vocabulary and 你: 檔案, 資料夾, 資料庫, 設定, 登入, 帳號, 伺服器, 網路, 預設, 搜尋,
  匯入. Never use mainland terms (文件夹, 数据库, 设置, 登录, 账户).
- Use full-width punctuation `，。：；？！（）` and the quotation marks `「」`, with `『』` inside them.
  Space around Latin text the same way as zh-Hans.
- In tables, 列 is a **row** and 欄 is a **column**, the reverse of zh-Hans. 文件 is a **document**
  and 檔案 is a **file**.

### ja

- Write sentences in です・ます. Buttons and menu items are nouns or the plain dictionary form
  (保存, 削除, 名前を変更). Don’t overuse ください.
- Use full-width `、。？！（）` and the quotation marks `「」`. Put no space between Japanese and Latin
  letters, digits or placeholders (`AIの編集`, `{count}件`).
- Write katakana with the long vowel: フォルダー, サーバー, ユーザー, メンバー, ブラウザー.
  Counters: 件 for items, rows and changes, 人 for people, 文字 for characters.

### ko

- Write sentences in 해요체 (`저장했어요`, `삭제할까요?`), never 합니다체. Buttons are nouns
  (저장, 삭제, 취소).
- Use half-width punctuation and the quotation marks `“ ”`. Follow standard Korean word spacing,
  and attach particles to placeholders (`{name}을(를)` is wrong; rephrase so no particle depends on
  the name, for example `“{name}” 삭제`).
- Put the count after the noun (`문서 #개`), and never pluralise with 들.

### de

- Address the reader as **du**, lowercase (`deine Dokumente`). Buttons use the infinitive
  (Speichern, Löschen).
- Capitalise nouns as German requires; otherwise use sentence case in headings and buttons, never
  English title case. Hyphenate a compound that contains a Latin acronym or a product name:
  `KI-Agent`, `API-Schlüssel`, `MCP-Server`, `Workspace-Name`.
- AI is **KI**. Use the generic masculine for role names; no gender stars or colons. Attach the
  ellipsis with no space (`Umbenennen…`).

### fr

- Address the reader as **vous**. Buttons use the infinitive (Enregistrer, Supprimer).
- Put a narrow no-break space U+202F before `:` `;` `?` `!` and inside `« »`, and never a plain
  space there, which can break the line (`Supprimer « {name} » ?`).
- Use sentence case everywhere, with no capital after a colon. AI is **IA** (`l’IA`, `agents IA`).

### es

- Address the reader as **tú**, never vosotros or usted. Use a neutral word when Spain and Latin
  America differ (`este equipo`, not ordenador or computadora). Buttons use the infinitive (Guardar,
  Eliminar).
- Always open a question or exclamation with `¿` and `¡`. Use sentence case.
- AI is **IA** (`la IA`). Settings is **Ajustes**, which keeps it apart from *configuración* (an
  app’s config).

### pt-BR

- Address the reader as **você**. Buttons use the infinitive (Salvar, Excluir).
- Use sentence case, and Brazilian vocabulary: arquivo, tela, excluir, baixar, fazer upload, senha.
- AI is **IA** (`a IA`). Sign in is **Entrar** and sign out is **Sair**.

## Terms

### Places and items

| English | zh-Hans | zh-Hant | ja | ko | de | fr | es | pt-BR | Note |
|---|---|---|---|---|---|---|---|---|---|
| node | 节点 | 節點 | ノード | 노드 | Knoten | nœud | nodo | nó | The server Stuga runs on, often a Mac in an office. |
| This node | 此节点 | 此節點 | このノード | 이 노드 | Dieser Knoten | Ce nœud | Este nodo | Este nó | Settings section. |
| Node settings | 节点设置 | 節點設定 | ノード設定 | 노드 설정 | Knoteneinstellungen | Paramètres du nœud | Ajustes del nodo | Configurações do nó | |
| Other nodes | 其他节点 | 其他節點 | 他のノード | 다른 노드 | Andere Knoten | Autres nœuds | Otros nodos | Outros nós | Workspace switcher. |
| server | 服务器 | 伺服器 | サーバー | 서버 | Server | serveur | servidor | servidor | Only where the English says server, in connection errors. Not node. |
| workspace | 工作空间 | 工作空間 | ワークスペース | 워크스페이스 | Workspace | espace de travail | espacio de trabajo | espaço de trabalho | de: der Workspace. |
| This workspace | 此工作空间 | 此工作空間 | このワークスペース | 이 워크스페이스 | Dieser Workspace | Cet espace de travail | Este espacio de trabajo | Este espaço de trabalho | Settings section. |
| Library | 文档库 | 文件庫 | ライブラリ | 라이브러리 | Bibliothek | Bibliothèque | Biblioteca | Biblioteca | Sidebar group. zh-Hant: never 資料庫 (= database). |
| document | 文档 | 文件 | ドキュメント | 문서 | Dokument | document | documento | documento | zh-Hans 文件 = file, zh-Hant 文件 = document. |
| folder | 文件夹 | 資料夾 | フォルダー | 폴더 | Ordner | dossier | carpeta | pasta | |
| Top level | 顶层 | 最上層 | 最上位 | 최상위 | Oberste Ebene | Niveau supérieur | Nivel superior | Nível superior | Not inside any folder. |
| All documents | 所有文档 | 所有文件 | すべてのドキュメント | 모든 문서 | Alle Dokumente | Tous les documents | Todos los documentos | Todos os documentos | Sidebar item and search scope. |
| Favorites | 收藏 | 收藏 | お気に入り | 즐겨찾기 | Favoriten | Favoris | Favoritos | Favoritos | “Star a document” = add it to favorites. |
| Shared with me | 与我共享 | 與我共用 | 自分と共有 | 나와 공유됨 | Mit mir geteilt | Partagés avec moi | Compartido conmigo | Compartilhados comigo | |
| collection | 文档集 | 文件集 | コレクション | 컬렉션 | Sammlung | collection | colección | coleção | A named set of documents the AI may search. Not favorites. |
| Trash | 回收站 | 垃圾桶 | ゴミ箱 | 휴지통 | Papierkorb | Corbeille | Papelera | Lixeira | |
| Move to Trash | 移到回收站 | 移至垃圾桶 | ゴミ箱に移動 | 휴지통으로 이동 | In den Papierkorb verschieben | Placer dans la corbeille | Mover a la papelera | Mover para a lixeira | |
| Delete forever | 永久删除 | 永久刪除 | 完全に削除 | 영구 삭제 | Endgültig löschen | Supprimer définitivement | Eliminar definitivamente | Excluir permanentemente | |
| Untitled | 未命名 | 未命名 | 無題 | 제목 없음 | Unbenannt | Sans titre | Sin título | Sem título | As a modifier: 未命名文件夹, 無題のフォルダー, 제목 없는 폴더, Unbenannter Ordner, Dossier sans titre. |
| title | 标题 | 標題 | タイトル | 제목 | Titel | titre | título | título | The title of a document. For a heading inside it, see Heading. |
| page | 页面 | 頁面 | ページ | 페이지 | Seite | page | página | página | A row’s page. |
| Outline | 大纲 | 大綱 | アウトライン | 개요 | Gliederung | Plan | Esquema | Sumário | Document side panel. |
| version | 版本 | 版本 | バージョン | 버전 | Version | version | versión | versão | A document version, and Stuga’s release version. |
| version history | 版本历史 | 版本記錄 | バージョン履歴 | 버전 기록 | Versionsverlauf | historique des versions | historial de versiones | histórico de versões | The “Versions” tab is the plural of version. |
| file | 文件 | 檔案 | ファイル | 파일 | Datei | fichier | archivo | arquivo | See document. |
| attachment | 附件 | 附件 | 添付ファイル | 첨부 파일 | Anhang | pièce jointe | archivo adjunto | anexo | |
| image | 图片 | 圖片 | 画像 | 이미지 | Bild | image | imagen | imagem | |
| upload | 上传 | 上傳 | アップロード | 업로드 | hochladen | téléverser | subir | fazer upload | Noun: 上传, Upload, téléversement, subida, upload. Not import. |
| download | 下载 | 下載 | ダウンロード | 다운로드 | herunterladen | télécharger | descargar | baixar | |
| import | 导入 | 匯入 | インポート | 가져오기 | importieren | importer | importar | importar | Noun: Import, importation, importación, importação. |
| export | 导出 | 匯出 | エクスポート | 내보내기 | exportieren | exporter | exportar | exportar | |
| archive (`.stuga.zip`) | 归档文件 | 封存檔 | アーカイブ | 아카이브 | Archiv | archive | archivo comprimido | arquivo compactado | es and pt-BR: archivo or arquivo alone means file. |
| sample workspace | 示例工作空间 | 範例工作空間 | サンプルワークスペース | 샘플 워크스페이스 | Beispiel-Workspace | espace de travail d’exemple | espacio de trabajo de ejemplo | espaço de trabalho de exemplo | The “Start with” choices: Empty, Sample, Import = 空白, 示例, 导入, and so on. |
| Sample | 示例 | 範例 | サンプル | 샘플 | Beispiel | Exemple | Ejemplo | Exemplo | |

### Databases

| English | zh-Hans | zh-Hant | ja | ko | de | fr | es | pt-BR | Note |
|---|---|---|---|---|---|---|---|---|---|
| database | 数据库 | 資料庫 | データベース | 데이터베이스 | Datenbank | base de données | base de datos | banco de dados | |
| table | 数据表 | 資料表 | テーブル | 테이블 | Tabelle | table | tabla | tabela | A table in a database. For the editor block, see Table (block). |
| view | 视图 | 檢視 | ビュー | 보기 | Ansicht | vue | vista | visualização | A saved filter, sort and grouping. “All rows” is the default view. |
| row | 行 | 列 | 行 | 행 | Zeile | ligne | fila | linha | zh-Hant 列 = row. zh-Hans 列 = column. Never mix them up. |
| column | 列 | 欄 | 列 | 열 | Spalte | colonne | columna | coluna | |
| cell | 单元格 | 儲存格 | セル | 셀 | Zelle | cellule | celda | célula | |
| row page | 行页面 | 列頁面 | 行ページ | 행 페이지 | Zeilenseite | page de ligne | página de fila | página da linha | |
| All rows | 所有行 | 所有列 | すべての行 | 모든 행 | Alle Zeilen | Toutes les lignes | Todas las filas | Todas as linhas | |
| Filter | 筛选 | 篩選 | フィルター | 필터 | Filtern | Filtrer | Filtrar | Filtrar | Noun: 筛选条件, Filter, filtre, filtro, filtro. |
| Sort | 排序 | 排序 | 並べ替え | 정렬 | Sortieren | Trier | Ordenar | Ordenar | |
| Group by | 分组依据 | 分組依據 | グループ化 | 그룹화 기준 | Gruppieren nach | Grouper par | Agrupar por | Agrupar por | |
| Text · Number · Checkbox · Date · Single select · Files | 文本 · 数字 · 复选框 · 日期 · 单选 · 文件 | 文字 · 數字 · 核取方塊 · 日期 · 單選 · 檔案 | テキスト · 数値 · チェックボックス · 日付 · 単一選択 · ファイル | 텍스트 · 숫자 · 체크박스 · 날짜 · 단일 선택 · 파일 | Text · Zahl · Kontrollkästchen · Datum · Einfachauswahl · Dateien | Texte · Nombre · Case à cocher · Date · Sélection unique · Fichiers | Texto · Número · Casilla · Fecha · Selección única · Archivos | Texto · Número · Caixa de seleção · Data · Seleção única · Arquivos | Column types. |
| Activity | 动态 | 動態 | アクティビティ | 활동 | Aktivität | Activité | Actividad | Atividade | A database’s change feed. |
| table assistant | 数据表助手 | 資料表助理 | テーブルアシスタント | 테이블 어시스턴트 | Tabellenassistent | assistant de table | asistente de tablas | assistente de tabelas | The built-in AI on a database. |
| schema | 结构 | 結構描述 | スキーマ | 스키마 | Schema | schéma | esquema | esquema | A database’s tables and columns, as the table assistant reads them. |

### People, sharing and sign-in

| English | zh-Hans | zh-Hant | ja | ko | de | fr | es | pt-BR | Note |
|---|---|---|---|---|---|---|---|---|---|
| account | 账户 | 帳號 | アカウント | 계정 | Konto | compte | cuenta | conta | |
| username | 用户名 | 使用者名稱 | ユーザー名 | 사용자 이름 | Benutzername | nom d’utilisateur | nombre de usuario | nome de usuário | |
| profile | 个人资料 | 個人檔案 | プロフィール | 프로필 | Profil | profil | perfil | perfil | |
| sign in | 登录 | 登入 | ログイン | 로그인 | anmelden | se connecter | iniciar sesión | entrar | Noun: 登录, Anmeldung, connexion, inicio de sesión, login. |
| sign out | 退出登录 | 登出 | ログアウト | 로그아웃 | abmelden | se déconnecter | cerrar sesión | sair | |
| password | 密码 | 密碼 | パスワード | 비밀번호 | Passwort | mot de passe | contraseña | senha | |
| passkey | 通行密钥 | 密碼金鑰 | パスキー | 패스키 | Passkey | clé d’accès | llave de acceso | chave de acesso | The OS vendors’ term. de: der Passkey, plural Passkeys. |
| setup code | 设置码 | 設定碼 | セットアップコード | 설정 코드 | Einrichtungscode | code de configuration | código de configuración | código de configuração | Claims a new node. |
| Set Up Stuga… | 设置 Stuga… | 設定 Stuga… | Stuga をセットアップ… | Stuga 설정… | Stuga einrichten… | Configurer Stuga… | Configurar Stuga… | Configurar o Stuga… | Mac menu-bar item; the web app quotes it, so both use exactly this. |
| Open Stuga | 打开 Stuga | 打開 Stuga | Stuga を開く | Stuga 열기 | Stuga öffnen | Ouvrir Stuga | Abrir Stuga | Abrir o Stuga | Mac menu-bar item. |
| Show Address as QR Code… | 以二维码显示地址… | 以 QR 碼顯示位址… | アドレスを QR コードで表示… | 주소를 QR 코드로 표시… | Adresse als QR-Code zeigen… | Afficher l’adresse en code QR… | Mostrar la dirección como código QR… | Mostrar o endereço como código QR… | Mac menu-bar item; the installer’s last page quotes it. |
| Show Setup Link as QR Code… | 以二维码显示设置链接… | 以 QR 碼顯示設定連結… | セットアップリンクを QR コードで表示… | 설정 링크를 QR 코드로 표시… | Einrichtungslink als QR-Code zeigen… | Afficher le lien de configuration en code QR… | Mostrar el enlace de configuración como código QR… | Mostrar o link de configuração como código QR… | Mac menu-bar item. |
| identity provider | 身份提供方 | 身分識別提供者 | IDプロバイダー | ID 공급자 | Identitätsanbieter | fournisseur d’identité | proveedor de identidad | provedor de identidade | OpenID Connect sign-in. |
| owner | 所有者 | 擁有者 | オーナー | 소유자 | Eigentümer | propriétaire | propietario | proprietário | Workspace role, and the owner of a document. |
| admin | 管理员 | 管理員 | 管理者 | 관리자 | Admin | administrateur | administrador | administrador | Workspace role. |
| member | 成员 | 成員 | メンバー | 멤버 | Mitglied | membre | miembro | membro | Workspace role. |
| guest | 访客 | 訪客 | ゲスト | 게스트 | Gast | invité | invitado | convidado | Workspace role: sees only what is shared with them. |
| node administrator | 节点管理员 | 節點管理員 | ノード管理者 | 노드 관리자 | Knotenadministrator | administrateur du nœud | administrador del nodo | administrador do nó | Not a workspace role. “Administrators” on node pages and “your administrator” both mean this. |
| Can view | 可查看 | 可檢視 | 閲覧可 | 보기 가능 | Kann ansehen | Peut consulter | Puede ver | Pode ver | Share role `viewer`. |
| Can comment | 可评论 | 可留言 | コメント可 | 댓글 가능 | Kann kommentieren | Peut commenter | Puede comentar | Pode comentar | Share role `commenter`, on documents only. |
| Can edit | 可编辑 | 可編輯 | 編集可 | 편집 가능 | Kann bearbeiten | Peut modifier | Puede editar | Pode editar | Share role `editor`. |
| No access | 无访问权限 | 無存取權 | アクセス権なし | 액세스 권한 없음 | Kein Zugriff | Aucun accès | Sin acceso | Sem acesso | |
| role | 角色 | 角色 | ロール | 역할 | Rolle | rôle | rol | função | |
| access | 访问权限 | 存取權 | アクセス権 | 액세스 권한 | Zugriff | accès | acceso | acesso | Whether someone can open an item. |
| permission | 权限 | 權限 | 権限 | 권한 | Berechtigung | autorisation | permiso | permissão | What someone may do. |
| General access | 常规访问权限 | 一般存取權 | 一般アクセス | 일반 액세스 | Allgemeiner Zugriff | Accès général | Acceso general | Acesso geral | Share dialog. |
| Inherited | 继承 | 繼承 | 継承 | 상속됨 | Geerbt | Hérité | Heredado | Herdado | Access that comes from a parent folder. |
| Request access | 申请访问权限 | 要求存取權 | アクセスをリクエスト | 액세스 요청 | Zugriff anfordern | Demander l’accès | Solicitar acceso | Solicitar acesso | |
| share | 共享 | 共用 | 共有 | 공유 | teilen | partager | compartir | compartilhar | Button: 共享, Teilen, Partager… |
| share link | 共享链接 | 共用連結 | 共有リンク | 공유 링크 | Link zum Teilen | lien de partage | enlace para compartir | link de compartilhamento | |
| link | 链接 | 連結 | リンク | 링크 | Link | lien | enlace | link | “Copy link” = 复制链接, Link kopieren, Copier le lien… |
| invite | 邀请 | 邀請 | 招待 | 초대 | einladen | inviter | invitar | convidar | Noun: 邀请, Einladung, invitation, invitación, convite. |
| invite link | 邀请链接 | 邀請連結 | 招待リンク | 초대 링크 | Einladungslink | lien d’invitation | enlace de invitación | link de convite | |
| group | 群组 | 群組 | グループ | 그룹 | Gruppe | groupe | grupo | grupo | A group of people. For grouping rows, see Group by. |
| collaborator | 协作者 | 協作者 | 共同編集者 | 공동 작업자 | Mitwirkende | collaborateur | colaborador | colaborador | Not co-author. |
| comment | 评论 | 留言 | コメント | 댓글 | Kommentar | commentaire | comentario | comentário | Verb: 评论, 留言, コメントする, 댓글 달기, kommentieren, commenter, comentar, comentar. |
| reply | 回复 | 回覆 | 返信 | 답글 | Antworten | Répondre | Responder | Responder | Noun: Antwort, réponse, respuesta, resposta. |
| Resolve / resolved | 解决 / 已解决 | 解決 / 已解決 | 解決 / 解決済み | 해결 / 해결됨 | Erledigen / erledigt | Résoudre / résolu | Resolver / resuelto | Resolver / resolvido | Comment threads. Reopen = 重新打开, 重新開啟, 再開, 다시 열기, Wieder öffnen, Rouvrir, Reabrir, Reabrir. |
| mention | 提及 | 提及 | メンション | 멘션 | erwähnen | mentionner | mencionar | mencionar | Noun: Erwähnung, mention, mención, menção. |
| notification | 通知 | 通知 | 通知 | 알림 | Benachrichtigung | notification | notificación | notificação | |
| alert | 警报 | 警示 | アラート | 경고 | Warnung | alerte | alerta | alerta | A warning to act on. Not a notification. |

### Settings and the node

| English | zh-Hans | zh-Hant | ja | ko | de | fr | es | pt-BR | Note |
|---|---|---|---|---|---|---|---|---|---|
| Settings | 设置 | 設定 | 設定 | 설정 | Einstellungen | Paramètres | Ajustes | Configurações | |
| Preferences | 偏好设置 | 偏好設定 | 個人設定 | 환경설정 | Präferenzen | Préférences | Preferencias | Preferências | Settings group for the person. |
| General | 常规 | 一般 | 一般 | 일반 | Allgemein | Général | General | Geral | |
| Appearance | 外观 | 外觀 | 外観 | 모양 | Darstellung | Apparence | Apariencia | Aparência | |
| Theme | 主题 | 主題 | テーマ | 테마 | Design | Thème | Tema | Tema | |
| System · Light · Dark | 跟随系统 · 浅色 · 深色 | 跟隨系統 · 淺色 · 深色 | システム · ライト · ダーク | 시스템 · 라이트 · 다크 | System · Hell · Dunkel | Système · Clair · Sombre | Sistema · Claro · Oscuro | Sistema · Claro · Escuro | Theme choices. |
| Language | 语言 | 語言 | 言語 | 언어 | Sprache | Langue | Idioma | Idioma | |
| Branding | 品牌 | 品牌 | ブランディング | 브랜딩 | Branding | Image de marque | Marca | Marca | |
| Storage | 存储 | 儲存空間 | ストレージ | 저장 공간 | Speicher | Stockage | Almacenamiento | Armazenamento | |
| remote access | 远程访问 | 遠端存取 | リモートアクセス | 원격 액세스 | Fernzugriff | accès à distance | acceso remoto | acesso remoto | |
| remote address | 远程地址 | 遠端位址 | リモートアドレス | 원격 주소 | Fernzugriffsadresse | adresse distante | dirección remota | endereço remoto | |
| public address | 公开地址 | 公開位址 | 公開アドレス | 공개 주소 | öffentliche Adresse | adresse publique | dirección pública | endereço público | |
| address | 地址 | 位址 | アドレス | 주소 | Adresse | adresse | dirección | endereço | A node’s web address. |
| connector | 连接器 | 連接器 | コネクタ | 커넥터 | Konnektor | connecteur | conector | conector | The program that carries remote access. |
| this computer | 此电脑 | 這台電腦 | このコンピューター | 이 컴퓨터 | dieser Computer | cet ordinateur | este equipo | este computador | |
| browser | 浏览器 | 瀏覽器 | ブラウザー | 브라우저 | Browser | navigateur | navegador | navegador | |
| network | 网络 | 網路 | ネットワーク | 네트워크 | Netzwerk | réseau | red | rede | |
| backup | 备份 | 備份 | バックアップ | 백업 | Backup | sauvegarde | copia de seguridad | backup | Verb: 备份, sichern, sauvegarder, hacer una copia de seguridad, fazer backup. |
| restore | 恢复 | 還原 | 復元 | 복원 | wiederherstellen | restaurer | restaurar | restaurar | From Trash, a version or a backup. Not revert or undo. |
| update | 更新 | 更新 | アップデート | 업데이트 | Update | mise à jour | actualización | atualização | Verb: aktualisieren, mettre à jour, actualizar, atualizar. |
| upgrade | 升级 | 升級 | アップグレード | 업그레이드 | Upgrade | mise à niveau | actualización | atualização | es and pt-BR use the same word for update and upgrade. |
| Release notes | 发行说明 | 版本資訊 | リリースノート | 릴리스 노트 | Versionshinweise | Notes de version | Notas de la versión | Notas da versão | |
| audit log | 审计日志 | 稽核記錄 | 監査ログ | 감사 로그 | Audit-Log | journal d’audit | registro de auditoría | registro de auditoria | “Node audit” = 节点审计, 節點稽核, ノード監査, 노드 감사, Knoten-Audit, Audit du nœud, Auditoría del nodo, Auditoria do nó. |
| usage | 用量 | 用量 | 使用量 | 사용량 | Nutzung | utilisation | uso | uso | “AI usage” = AI 用量, AI使用量, KI-Nutzung, utilisation de l’IA, uso de IA. |
| Danger zone | 危险区域 | 危險區域 | 危険な操作 | 위험 구역 | Gefahrenbereich | Zone de danger | Zona de peligro | Zona de perigo | |

### AI, review and agents

| English | zh-Hans | zh-Hant | ja | ko | de | fr | es | pt-BR | Note |
|---|---|---|---|---|---|---|---|---|---|
| AI | AI | AI | AI | AI | KI | IA | IA | IA | |
| Built-in AI | 内置 AI | 內建 AI | 組み込みAI | 내장 AI | Integrierte KI | IA intégrée | IA integrada | IA integrada | The co-author, Ask and the table assistant, run on the node’s provider. |
| AI chat | AI 聊天 | AI 聊天 | AIチャット | AI 채팅 | KI-Chat | chat IA | chat de IA | chat de IA | “New chat” = 新对话, 新對話, 新しいチャット, 새 채팅, Neuer Chat, Nouvelle discussion, Nuevo chat, Novo chat. |
| conversation | 对话 | 對話 | 会話 | 대화 | Unterhaltung | conversation | conversación | conversa | |
| AI co-author | AI 共同作者 | AI 共同作者 | AI共著者 | AI 공동 작성자 | KI-Koautor | coauteur IA | coautor de IA | coautor de IA | The AI panel in a document. Not collaborator. |
| Edit with AI | 用 AI 编辑 | 使用 AI 編輯 | AIで編集 | AI로 편집 | Mit KI bearbeiten | Modifier avec l’IA | Editar con IA | Editar com IA | |
| Ask | 提问 | 提問 | 質問 | 질문하기 | Fragen | Demander | Preguntar | Perguntar | The feature’s name and its send button. Translated. |
| Ask your documents | 向文档提问 | 向文件提問 | ドキュメントに質問 | 문서에 질문하기 | Frag deine Dokumente | Interroger vos documents | Pregunta a tus documentos | Pergunte aos seus documentos | Sidebar item and page title. |
| knowledge base | 知识库 | 知識庫 | ナレッジベース | 지식 베이스 | Wissensdatenbank | base de connaissances | base de conocimiento | base de conhecimento | The documents the co-author may search. |
| Sources | 来源 | 來源 | 出典 | 출처 | Quellen | Sources | Fuentes | Fontes | Documents an answer cites. |
| citation | 引用 | 引用 | 引用元 | 인용 | Quellenverweis | référence | referencia | referência | A marker linking to a source. Not the Quote block. |
| search scope | 搜索范围 | 搜尋範圍 | 検索範囲 | 검색 범위 | Suchbereich | portée de la recherche | ámbito de búsqueda | escopo da pesquisa | |
| provider | 服务商 | 供應商 | プロバイダー | 제공업체 | Anbieter | fournisseur | proveedor | provedor | “AI providers” = AI 服务商, KI-Anbieter, fournisseurs d’IA… |
| Service | 服务 | 服務 | サービス | 서비스 | Dienst | Service | Servicio | Serviço | The provider picker’s label. |
| model | 模型 | 模型 | モデル | 모델 | Modell | modèle | modelo | modelo | “Default model” = 默认模型, 預設模型, デフォルトモデル, 기본 모델, Standardmodell, modèle par défaut, modelo predeterminado, modelo padrão. |
| API key | API 密钥 | API 金鑰 | APIキー | API 키 | API-Schlüssel | clé d’API | clave de API | chave de API | |
| key | 密钥 | 金鑰 | キー | 키 | Schlüssel | clé | clave | chave | An agent’s key. |
| embedding model | 嵌入模型 | 嵌入模型 | 埋め込みモデル | 임베딩 모델 | Embedding-Modell | modèle d’embedding | modelo de embeddings | modelo de embeddings | |
| re-index | 重建索引 | 重建索引 | 再インデックス | 재색인 | neu indexieren | réindexer | reindexar | reindexar | Noun “index” = 索引, 索引, インデックス, 색인, Index, index, índice, índice. |
| Reranking | 重排序 | 重新排序 | リランキング | 재순위화 | Reranking | Reclassement | Reordenación | Reclassificação | |
| Search strictness: Strict · Balanced · Loose | 搜索严格度：严格 · 平衡 · 宽松 | 搜尋嚴格度：嚴格 · 平衡 · 寬鬆 | 検索の厳密さ：厳密 · 標準 · 緩め | 검색 엄격도: 엄격 · 균형 · 느슨 | Suchstrenge: Streng · Ausgewogen · Locker | Rigueur de recherche : Stricte · Équilibrée · Souple | Rigor de búsqueda: Estricto · Equilibrado · Flexible | Rigor da pesquisa: Rígido · Equilibrado · Flexível | |
| AI edits | AI 编辑 | AI 編輯 | AIの編集 | AI 편집 | KI-Änderungen | modifications de l’IA | ediciones de IA | edições da IA | Edits from agents and the co-author alike. |
| Review AI edits | 审阅 AI 编辑 | 審閱 AI 編輯 | AIの編集をレビュー | AI 편집 검토 | KI-Änderungen prüfen | Vérifier les modifications de l’IA | Revisar ediciones de IA | Revisar edições da IA | The review inbox (`/review`). Sidebar item and page title. |
| review | 审阅 | 審閱 | レビュー | 검토 | prüfen | vérifier | revisar | revisar | Noun: 审阅, Prüfung, vérification, revisión, revisão. |
| Needs review | 待审阅 | 待審閱 | 要レビュー | 검토 필요 | Prüfung nötig | À vérifier | Pendiente de revisión | Aguardando revisão | Inbox tab. Next to it: In progress · Finished · Everything = 进行中 · 已完成 · 全部 (zh-Hant 進行中 · 已完成 · 全部; ja 進行中 · 完了 · すべて; ko 진행 중 · 완료 · 전체; de Läuft · Abgeschlossen · Alle; fr En cours · Terminées · Tout; es En curso · Terminadas · Todo; pt-BR Em andamento · Concluídas · Tudo). |
| Let AI edits apply directly | 允许 AI 编辑直接应用 | 允許 AI 編輯直接套用 | AIの編集を直接適用する | AI 편집 바로 적용 | KI-Änderungen direkt übernehmen | Appliquer directement les modifications de l’IA | Aplicar directamente las ediciones de IA | Aplicar diretamente as edições da IA | ⋯ menu item. |
| Make AI edits wait for review | 让 AI 编辑等待审阅 | 讓 AI 編輯等待審閱 | AIの編集をレビュー待ちにする | AI 편집을 검토 후 적용 | KI-Änderungen auf Prüfung warten lassen | Soumettre les modifications de l’IA à vérification | Hacer que las ediciones de IA esperen revisión | Fazer as edições da IA aguardarem revisão | ⋯ menu item, the reverse of the one above. |
| AI edits apply directly | AI 编辑直接应用 | AI 編輯直接套用 | AIの編集を直接適用 | AI 편집 바로 적용됨 | KI-Änderungen direkt übernommen | Modifications de l’IA appliquées directement | Ediciones de IA aplicadas directamente | Edições da IA aplicadas diretamente | Status chip. |
| review mode | 审阅模式 | 審閱模式 | レビューモード | 검토 모드 | Prüfmodus | mode vérification | modo de revisión | modo de revisão | Docs only. The UI shows the two menu items above. |
| apply | 应用 | 套用 | 適用 | 적용 | übernehmen | appliquer | aplicar | aplicar | Edits that land. de: the Apply button on a filter is “Anwenden”. “Applied” = 已应用, 已套用, 適用済み, 적용됨, Übernommen, Appliqué, Aplicado, Aplicado. |
| Accept | 接受 | 接受 | 承認 | 수락 | Annehmen | Accepter | Aceptar | Aceitar | |
| Reject | 拒绝 | 拒絕 | 拒否 | 거부 | Ablehnen | Refuser | Rechazar | Rejeitar | |
| Accept all · Reject all | 全部接受 · 全部拒绝 | 全部接受 · 全部拒絕 | すべて承認 · すべて拒否 | 모두 수락 · 모두 거부 | Alle annehmen · Alle ablehnen | Tout accepter · Tout refuser | Aceptar todo · Rechazar todo | Aceitar tudo · Rejeitar tudo | |
| Reject with note | 附说明拒绝 | 附註拒絕 | メモを付けて拒否 | 메모와 함께 거부 | Mit Notiz ablehnen | Refuser avec une note | Rechazar con nota | Rejeitar com nota | The button that opens the note and the one that sends it say the same thing. |
| note | 说明 | 附註 | メモ | 메모 | Notiz | note | nota | nota | A note left for an agent when rejecting. |
| Review each | 逐条审阅 | 逐一審閱 | 個別にレビュー | 하나씩 검토 | Einzeln prüfen | Vérifier une par une | Revisar una por una | Revisar uma por uma | |
| Mark as reviewed | 标记为已审阅 | 標示為已審閱 | レビュー済みにする | 검토 완료로 표시 | Als geprüft markieren | Marquer comme vérifié | Marcar como revisado | Marcar como revisado | |
| Undo | 撤销 | 復原 | 元に戻す | 실행 취소 | Rückgängig | Annuler | Deshacer | Desfazer | Reverses a decision or an edit. fr: same word as Cancel. |
| Redo | 重做 | 取消復原 | やり直す | 다시 실행 | Wiederholen | Rétablir | Rehacer | Refazer | |
| Revert | 撤回 | 撤回 | 取り消す | 되돌리기 | Zurücknehmen | Revenir en arrière | Revertir | Reverter | Takes back changes that already landed. Not undo or restore. fr in a sentence: “revenir sur ces modifications”. |
| Revise… | 修改… | 修改… | 修正… | 수정… | Überarbeiten… | Retravailler… | Reescribir… | Reescrever… | The co-author rewrites from a rejection note. Not review. |
| propose / suggestion | 建议 | 建議 | 提案 | 제안 | vorschlagen / Vorschlag | proposer / suggestion | proponer / sugerencia | propor / sugestão | “Propose edits” and “suggest changes” are one idea; use one word for both. |
| change | 更改 | 變更 | 変更 | 변경 | Änderung | modification | cambio | alteração | |
| pending | 待定 | 待定 | 保留中 | 대기 중 | ausstehend | en attente | pendiente | pendente | A proposal not yet decided. |
| agent | 智能体 | 代理 | エージェント | 에이전트 | Agent | agent | agente | agente | An outside AI app connected over MCP. |
| Your AI agents | 你的 AI 智能体 | 你的 AI 代理 | あなたのAIエージェント | 내 AI 에이전트 | Deine KI-Agenten | Vos agents IA | Tus agentes de IA | Seus agentes de IA | Settings page and command. |
| Connected agents | 已连接的智能体 | 已連線的代理 | 接続済みのエージェント | 연결된 에이전트 | Verbundene Agenten | Agents connectés | Agentes conectados | Agentes conectados | |
| connect | 连接 | 連線 | 接続 | 연결 | verbinden | connecter | conectar | conectar | “Connect an agent” = 连接智能体, 連線代理, エージェントを接続, 에이전트 연결, Agent verbinden, Connecter un agent, Conectar un agente, Conectar um agente. |
| connection (grant) | 连接 | 連線 | 接続 | 연결 | Verbindung | connexion | conexión | conexão | The UI’s word for a grant. Never translate “grant” literally. |
| app | 应用 | 應用程式 | アプリ | 앱 | App | application | aplicación | aplicativo | An MCP client that signs in. |
| Allow · Deny | 允许 · 拒绝 | 允許 · 拒絕 | 許可 · 拒否 | 허용 · 거부 | Zulassen · Ablehnen | Autoriser · Refuser | Permitir · Denegar | Permitir · Negar | The app sign-in screen. |
| Revoke | 取消授权 | 撤銷授權 | 無効化 | 해제 | Widerrufen | Révoquer | Revocar | Revogar | Ends a connection, key or invite link. |
| Rotate | 轮换 | 輪替 | 再発行 | 재발급 | Erneuern | Renouveler | Renovar | Renovar | Issues a new key and retires the old one. |
| Read only | 只读 | 唯讀 | 読み取り専用 | 읽기 전용 | Nur lesen | Lecture seule | Solo lectura | Somente leitura | |
| Read and suggest changes | 读取并建议更改 | 讀取並建議變更 | 読み取りと変更の提案 | 읽기 및 변경 제안 | Lesen und Änderungen vorschlagen | Lecture et suggestion de modifications | Leer y sugerir cambios | Ler e sugerir alterações | Translate “Read and propose edits” the same way. |
| instructions | 指令 | 指令 | 指示 | 지침 | Anweisungen | instructions | instrucciones | instruções | Text that stacks from the workspace down through folders to the item. It is advice to a model, not a rule; don’t word it as one. |
| Instructions for agents | 智能体指令 | 代理指令 | エージェントへの指示 | 에이전트 지침 | Anweisungen für Agenten | Instructions pour les agents | Instrucciones para agentes | Instruções para agentes | |
| run | 运行 | 執行 | 実行 | 실행 | Durchlauf | exécution | ejecución | execução | One agent’s editing session on one item. Never 会话 or session, which mean sign-in sessions. |
| AI activity | AI 动态 | AI 動態 | AIアクティビティ | AI 활동 | KI-Aktivität | Activité de l’IA | Actividad de IA | Atividade da IA | Each agent’s record in the inbox. |
| run ledger | 运行记录 | 執行紀錄 | 実行履歴 | 실행 기록 | Durchlaufprotokoll | journal des exécutions | registro de ejecuciones | registro de execuções | Docs wording. In the UI it is AI activity. |
| provenance | 作者记录 | 作者紀錄 | 作成者の記録 | 작성자 기록 | Urheberschaft | provenance | procedencia | procedência | Which passages an agent wrote, and whether a person accepted them. |
| MCP endpoint | MCP 端点 | MCP 端點 | MCPエンドポイント | MCP 엔드포인트 | MCP-Endpunkt | point de terminaison MCP | endpoint de MCP | endpoint MCP | |
| config | 配置 | 設定檔 | 設定 | 구성 | Konfiguration | configuration | configuración | configuração | An agent’s config snippet. |

### Search

| English | zh-Hans | zh-Hant | ja | ko | de | fr | es | pt-BR | Note |
|---|---|---|---|---|---|---|---|---|---|
| search | 搜索 | 搜尋 | 検索 | 검색 | suchen | rechercher | buscar | pesquisar | Noun: Suche, recherche, búsqueda, pesquisa. |
| keyword search | 关键词搜索 | 關鍵字搜尋 | キーワード検索 | 키워드 검색 | Stichwortsuche | recherche par mots-clés | búsqueda por palabras clave | pesquisa por palavras-chave | “Matching words only” is the same idea. |
| Semantic search | 语义搜索 | 語意搜尋 | セマンティック検索 | 시맨틱 검색 | Semantische Suche | Recherche sémantique | Búsqueda semántica | Pesquisa semântica | |
| Languages in your documents | 文档中的语言 | 文件中的語言 | ドキュメントの言語 | 문서의 언어 | Sprachen in deinen Dokumenten | Langues de vos documents | Idiomas de tus documentos | Idiomas dos seus documentos | The search-languages setting. Not the interface language. |
| Always on | 始终启用 | 一律啟用 | 常に有効 | 항상 사용 | Immer aktiv | Toujours actif | Siempre activo | Sempre ativo | Search-language list section. |
| Hidden from search · Hide from search · Show in search | 已从搜索中隐藏 · 从搜索中隐藏 · 在搜索中显示 | 已從搜尋中隱藏 · 從搜尋中隱藏 · 在搜尋中顯示 | 検索に非表示 · 検索に表示しない · 検索に表示 | 검색에서 숨겨짐 · 검색에서 숨기기 · 검색에 표시 | In der Suche ausgeblendet · In der Suche ausblenden · In der Suche anzeigen | Masqué dans la recherche · Masquer dans la recherche · Afficher dans la recherche | Oculto en la búsqueda · Ocultar en la búsqueda · Mostrar en la búsqueda | Oculto na pesquisa · Ocultar da pesquisa · Mostrar na pesquisa | |

### Editor

| English | zh-Hans | zh-Hant | ja | ko | de | fr | es | pt-BR | Note |
|---|---|---|---|---|---|---|---|---|---|
| Heading 1 · 2 · 3 | 标题 1 · 2 · 3 | 標題 1 · 2 · 3 | 見出し1 · 2 · 3 | 제목 1 · 2 · 3 | Überschrift 1 · 2 · 3 | Titre 1 · 2 · 3 | Encabezado 1 · 2 · 3 | Título 1 · 2 · 3 | Slash menu and block-type menu. Keep the H1–H3 shortcuts as they are. |
| Normal text | 正文 | 內文 | 標準テキスト | 일반 텍스트 | Normaler Text | Texte normal | Texto normal | Texto normal | |
| Bullet list | 无序列表 | 項目符號清單 | 箇条書きリスト | 글머리 기호 목록 | Aufzählung | Liste à puces | Lista con viñetas | Lista com marcadores | |
| Numbered list | 有序列表 | 編號清單 | 番号付きリスト | 번호 매기기 목록 | Nummerierte Liste | Liste numérotée | Lista numerada | Lista numerada | |
| Quote | 引述 | 引言 | 引用 | 인용구 | Zitat | Citation | Cita | Citação | A block. Not citation. |
| Code block | 代码块 | 程式碼區塊 | コードブロック | 코드 블록 | Codeblock | Bloc de code | Bloque de código | Bloco de código | |
| Table (block) | 表格 | 表格 | 表 | 표 | Tabelle | Tableau | Tabla | Tabela | A table inside a document. |
| Image | 图片 | 圖片 | 画像 | 이미지 | Bild | Image | Imagen | Imagem | |
| File | 文件 | 檔案 | ファイル | 파일 | Datei | Fichier | Archivo | Arquivo | |
| Mermaid diagram | Mermaid 图表 | Mermaid 圖表 | Mermaid図 | Mermaid 다이어그램 | Mermaid-Diagramm | Diagramme Mermaid | Diagrama Mermaid | Diagrama Mermaid | |
| Divider | 分割线 | 分隔線 | 区切り線 | 구분선 | Trennlinie | Séparateur | Divisor | Divisor | |
| block | 块 | 區塊 | ブロック | 블록 | Block | bloc | bloque | bloco | “Insert block” = 插入块, 插入區塊, ブロックを挿入, 블록 삽입, Block einfügen, Insérer un bloc, Insertar bloque, Inserir bloco. |
| Bold · Italic · Underline · Strikethrough · Inline code | 粗体 · 斜体 · 下划线 · 删除线 · 行内代码 | 粗體 · 斜體 · 底線 · 刪除線 · 行內程式碼 | 太字 · 斜体 · 下線 · 取り消し線 · インラインコード | 굵게 · 기울임꼴 · 밑줄 · 취소선 · 인라인 코드 | Fett · Kursiv · Unterstrichen · Durchgestrichen · Inline-Code | Gras · Italique · Souligné · Barré · Code en ligne | Negrita · Cursiva · Subrayado · Tachado · Código en línea | Negrito · Itálico · Sublinhado · Tachado · Código embutido | Keep the shortcut as it is: `Bold (⌘B)` → `粗体 (⌘B)`, with full-width parentheses in CJK: `粗体（⌘B）`. |
| View | 显示 | 顯示 | 表示 | 보기 | Ansicht | Affichage | Visualización | Exibição | A document’s display menu (zoom, page width). Not a database view. |
| caption | 说明文字 | 說明文字 | キャプション | 캡션 | Bildunterschrift | légende | pie de foto | legenda | |

### Common actions

| English | zh-Hans | zh-Hant | ja | ko | de | fr | es | pt-BR | Note |
|---|---|---|---|---|---|---|---|---|---|
| Save | 保存 | 儲存 | 保存 | 저장 | Speichern | Enregistrer | Guardar | Salvar | |
| Cancel | 取消 | 取消 | キャンセル | 취소 | Abbrechen | Annuler | Cancelar | Cancelar | |
| Close | 关闭 | 關閉 | 閉じる | 닫기 | Schließen | Fermer | Cerrar | Fechar | |
| Done | 完成 | 完成 | 完了 | 완료 | Fertig | Terminé | Listo | Concluído | |
| Delete | 删除 | 刪除 | 削除 | 삭제 | Löschen | Supprimer | Eliminar | Excluir | Destroys the item. |
| Remove | 移除 | 移除 | 削除 | 제거 | Entfernen | Retirer | Quitar | Remover | Takes something out of a list or an item. ja uses 削除 for both. |
| Rename | 重命名 | 重新命名 | 名前を変更 | 이름 바꾸기 | Umbenennen | Renommer | Cambiar nombre | Renomear | |
| Create | 创建 | 建立 | 作成 | 만들기 | Erstellen | Créer | Crear | Criar | |
| New | 新建 | 新增 | 新規 | 새로 만들기 | Neu | Nouveau | Nuevo | Novo | Prefix in “New document”: 新建文档, 新增文件, 新規ドキュメント, 새 문서, Neues Dokument, Nouveau document, Nuevo documento, Novo documento. |
| Open | 打开 | 開啟 | 開く | 열기 | Öffnen | Ouvrir | Abrir | Abrir | |
| Copy · Copied | 复制 · 已复制 | 複製 · 已複製 | コピー · コピーしました | 복사 · 복사됨 | Kopieren · Kopiert | Copier · Copié | Copiar · Copiado | Copiar · Copiado | |
| Retry · Try again | 重试 | 重試 | 再試行 | 다시 시도 | Erneut versuchen | Réessayer | Reintentar | Tentar novamente | Both English labels take this one word. |
| Edit | 编辑 | 編輯 | 編集 | 편집 | Bearbeiten | Modifier | Editar | Editar | |
| Add | 添加 | 新增 | 追加 | 추가 | Hinzufügen | Ajouter | Añadir | Adicionar | |
| Send | 发送 | 傳送 | 送信 | 보내기 | Senden | Envoyer | Enviar | Enviar | |
| Dismiss | 忽略 | 忽略 | 閉じる | 닫기 | Ausblenden | Ignorer | Descartar | Dispensar | |
| Turn on · Turn off | 开启 · 关闭 | 開啟 · 關閉 | オンにする · オフにする | 켜기 · 끄기 | Aktivieren · Deaktivieren | Activer · Désactiver | Activar · Desactivar | Ativar · Desativar | |
| On · Off | 开 · 关 | 開 · 關 | オン · オフ | 켬 · 끔 | An · Aus | Activé · Désactivé | Activado · Desactivado | Ativado · Desativado | |
| Loading… | 正在加载… | 載入中… | 読み込み中… | 불러오는 중… | Wird geladen… | Chargement… | Cargando… | Carregando… | |

## Do not translate

Leave these exactly as written in every language. Grammar may go around them (`Stuga 的`,
`Stugaの`, `de Stuga`) but never inside them.

- **Names:** Stuga, MCP, Markdown, Notion, Obsidian, Postgres, pgvector, pg_search, Mermaid,
  OpenID Connect, OAuth, GitHub, Docker, Let’s Encrypt (and its *Subscriber Agreement*, which
  exists only in English), Slack, Microsoft Teams, Discord, Claude, Claude Code, Claude Desktop,
  Codex, Antigravity, Cursor, VS Code, Kiro, Goose, LM Studio, DeepSeek Harness, Pi, Ollama, OpenAI,
  Anthropic, Gemini, DeepSeek, and every other provider name in the AI provider list. Skill, as in
  “the Stuga Skill”.
- **Acronyms and formats:** API, URL, HTTP, HTTPS, JSON, JSONL, CSV, SMTP, HMAC-SHA256, UTC, ID
  (`Node ID` → `节点 ID`), MB, AGPL-3.0-only.
- **Code and config:** every argument and tag name in braces and angle brackets, and plural and
  select keywords; header and environment names such as `X-Stuga-Signature`, `PUBLIC_ORIGIN`,
  `EXTRA_ORIGINS`, `STUGA_URL`, `$DSH_HOME/.env`; commands and slash commands such as `/mcp`,
  `/mcp-auth stuga`, `./stuga status`, `frpc -c …`, `claude mcp remove …`; URLs and URL schemes
  (`goose://…`, `https://`); placeholder formats such as `XXXX-XXXX-XXXX-XXXX` and
  `gpt-4.1=GPT-4.1, o3-mini=o3 mini`; model ids.
- **File names and extensions:** `.stuga.zip`, `.pkg`, `.zip`, `.md`, `.csv`, `.jsonl`, `.env`,
  `Stuga.pkg`.
- **Keys and symbols:** ⌘ ⇧ ⌥ ⌃ ↩ ⋯ →, the shortcuts `⌘B`, `⌘Z` and `⌘⇧Z`, `H1`–`H3`, `@` for
  mentions, `/` for the slash menu, and the key names **Enter** and **Shift**.
- **Menu paths in other apps:** `Settings → Connectors → Add custom connector`,
  `Settings → Developer → Edit Config`, `Settings → Customizations → Installed MCP Servers`,
  `Settings → Extensions`.
