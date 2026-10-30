# Claude Persistent Agent (Windows 11)

Kendi **izole Claude aboneliği hesabıyla** arka planda sürekli çalışan, telefondan **Remote Control** ile yönetilebilen ve oturum kapanırsa **GitHub üzerinden yeniden giriş** başlatılabilen ajan.

```
Windows oturum açılışı ─► Görev Zamanlayıcı ─► run.ps1 (bekçi, çökerse yeniden başlatır)
                                                  └► node src/cli.js run  (gözetmen)
                                                        ├─ her 60 sn: claude auth status   (izole CLAUDE_CONFIG_DIR)
                                                        ├─ giriş açık  ► claude remote-control  (telefon: Claude uygulaması)
                                                        └─ logout      ► remote-control durur, GitHub issue her 60 sn okunur
                                                                         "/login" ► claude auth login --claudeai
```

## Doğrulanan teknik sınırlar (bu makinede, Claude Code 2.1.314)

| Konu | Bulgu |
|---|---|
| İzolasyon | `CLAUDE_CONFIG_DIR=<dizin>` ile `claude auth status` izole dizini bildirir (`configDirectory`), global `~\.claude` hesabı etkilenmez. Her kontrolde bu alan doğrulanır. |
| Giriş | Resmi `claude auth login --claudeai` bir URL basar ve stdin'den kod bekler. Tarayıcı **bu bilgisayarda** açılıp onaylanırsa akış kendiliğinden biter; başka cihazda onaylanırsa ekrandaki kod girilmelidir. |
| Remote Control | `claude remote-control` yalnızca claude.ai aboneliğiyle çalışır; **giriş yoksa çıkar** (“You must be logged in”). Bu yüzden oturum kapanınca telefondan erişim de kalkar; GitHub kanalı bu boşluk için vardır. |
| Tam otomatik giriş | **Mümkün değil** ve yapılmaz: onay adımı kullanıcı etkileşimi ister. Başarı yalnızca `auth status` `loggedIn:true` dönerse sayılır. |

### Yalnızca GitHub ile yeniden giriş (AnyDesk gerekmez)
1. Logout 2 ardışık kontrolde (≈2 dk) doğrulanınca ajan **kendiliğinden** `claude auth login --claudeai` başlatır ve bağlantıyı issue'ya yazar.
2. Telefonda bağlantıyı açıp onaylayın; ekrandaki kodu aynı issue'ya `/code KOD` olarak yazın.
3. Ajan her 60 sn yorumları okur; kodu **o giriş sürecinin** stdin'ine gönderir, `auth status` ile doğrular, Remote Control'ü yeniden başlatır.
4. Kod yorumu ve bağlantı yorumu silinir; sonuç issue'ya yazılır.

Kurallar: kod yalnızca `allowedUsers` listesinden kabul edilir; her giriş sürecinin kimliği (#id) ve OAuth `state` değeri izlenir (`KOD#STATE` biçimindeki kodda state uyuşmazsa, ya da bağlantı yorumundan önce yazılmışsa iletilmez). Kod reddedilirse ya da süre (`loginTimeoutSec`, 10 dk) dolarsa yeni süreç/yeni bağlantı üretilir (reddedilmede hemen, diğerlerinde 30 sn→5 dk geri çekilmeyle). `/login` yeni bağlantı ister, `/cancel-login` otomatik girişi durdurur. Depo **private** değilse giriş hiç başlatılmaz.

**Gerçek CLI ile doğrulananlar:** `claude auth login` TTY olmadan, borulu stdin'den kodu okur ve sunucuda doğrular; yanlış kodda `Login failed: That code wasn't accepted` ile çıkış kodu 1 verir. Bir süreç **tek** kod denemesi yapar. **Doğrulanamayanlar:** geçerli bir kodla başarılı giriş (onay kullanıcı etkileşimi ister) ve kodun biçimi (`KOD` mu `KOD#STATE` mi — ikisi de desteklenir).

**Bilinen kısıtlar:** CLI her giriş sürecinde PC'de tarayıcı açar (`BROWSER` değişkeni yok sayılıyor); tekrarlanan girişlerde sekme açılabilir. Kod GitHub'da (özel depoda) yeni bir yorum olarak kısa süre görünür, bildirim/e-posta kopyası kalabilir; bu yüzden kod yalnızca tek kullanımlıktır ve hemen silinir. Başka hesabın yorumunu silmek için token sahibinin depoda yazma yetkisi gerekir; silinemezse ajan uyarı yorumu yazar.

## Telefondan kontrol

1. Ajan hesabıyla giriş yapıldıktan sonra ajan `claude remote-control` başlatır; oturum adı `Claude Agent (<bilgisayar adı>)`.
2. Telefonda **Claude uygulamasını aynı hesapla** açın → Code bölümünden oturumu seçin (veya claude.ai/code).
3. İzin modu varsayılan `default`'tur (`config.json` → `remoteControl.permissionMode`). Telefonda onay vermeniz gerekir; `bypassPermissions` bilerek seçilmelidir.
4. Oturum kapanırsa ajan otomatik giriş bağlantısı yazar; yukarıdaki akışı izleyin.

GitHub tarafı için: **özel (private)** bir depo + bir issue, GitHub mobil uygulamasında issue'yu "Subscribe" edin. Not: ajan kendi yorumlarını sizin token'ınızla yazar; GitHub kendi yorumunuz için bildirim göndermez. Bildirim için ajana ayrı bir (bot) GitHub hesabının token'ını verin.

## Kurulum

### Hazırlık (bir kez)
1. **Kontrol deposu:** GitHub'da bir **özel (private)** depo açın (ör. `claude-agent-control`). Ajan giriş bağlantısını ve tek kullanımlık kodu burada taşır.
2. **Token:** GitHub → Settings → Developer settings → *Fine-grained tokens*. Repository access: yalnızca o kontrol deposu. İzin: **Issues: Read and write** (Metadata: read otomatik). Kurulumda bir kez yapıştıracaksınız; Windows DPAPI ile şifrelenip saklanır.

### Çift tıkla kurulum (komut yazmadan)
[`Kur.cmd`](https://raw.githubusercontent.com/onurclaude/claude-agent/main/Kur.cmd) dosyasını indirip (sağ tık → *Farklı kaydet*) çift tıklayın. Pencerede kontrol deposunu (`sahip/depo`) ve GitHub token'ını sorar, gerisini kendisi yapar; zaten kuruluysa hiçbir şey değiştirmez. Kaldırmak için [`Kaldir.cmd`](https://raw.githubusercontent.com/onurclaude/claude-agent/main/Kaldir.cmd) dosyasını çift tıklayın (veriyi de silip silmeyeceğinizi sorar). Windows "tanınmayan uygulama" uyarısı gösterirse *Yine de çalıştır* deyin.

### Tek komutla kurulum (git, Node.js, Claude Code gerekmez; eksikse kendisi kurar)
```powershell
irm https://raw.githubusercontent.com/onurclaude/claude-agent/main/scripts/bootstrap.ps1 -OutFile $env:TEMP\ca.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\ca.ps1 -Repo SAHIP/claude-agent-control -AllowedUser SAHIP
```
`bootstrap.ps1` sırayla: Node.js 20+ (winget) ve Claude Code (npm) eksikse kurar → projeyi `%LOCALAPPDATA%\ClaudeAgent\app` altına indirir → `install.ps1`'i çalıştırır (ayarlar, token, izolasyon doğrulaması, oturum açılışında otomatik başlatma) → bu bilgisayar için kontrol deposunda **kendi issue'sunu** açar. Yönetici yetkisi gerekmez (Node.js kurucusu UAC isteyebilir).

**Zaten kuruluysa hiçbir şey yapmaz** ("Zaten kurulu" der, görev durmuşsa yalnızca başlatır). Güncellemek için `-Update`, `install.ps1`'i zorla yeniden çalıştırmak için `-Force`.

Depoyu elle indirdiyseniz: `scripts\bootstrap.ps1 -Repo SAHIP/claude-agent-control -AllowedUser SAHIP`.

Her bilgisayar için **ayrı issue** kullanılır (aynı issue'yu iki ajan okursa `/code` yorumları çakışır); bootstrap bunu otomatik yapar. Kurulum izolasyonu doğrular, doğrulanamazsa otomatik başlatma **kurulmaz**.

İlk giriş: oturum kapalı olduğundan ajan bağlantıyı kendiliğinden issue'ya yazar (veya `/login`).

### Kurulumu kontrol etme
```powershell
Get-ScheduledTask ClaudePersistentAgent                    # Görev Zamanlayıcı'daki görev adı; State: Running olmalı
Test-Path $env:LOCALAPPDATA\ClaudeAgent                    # True olmalı (veri/giriş klasörü)
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'AnyDeskClaude\\(scripts|src)|ClaudeAgent' } | Select ProcessId, Name
scripts\status.ps1                                         # görev + ajan durumu + canlı auth
```
Görev Yöneticisi'nde görev adı görünmez, süreçler görünür: `powershell.exe` (bekçi), `node.exe` (ajan), `claude.exe` (Remote Control), `conhost.exe`. Ayrıntılar sekmesinde **Komut satırı** sütununu açıp `ClaudeAgent` / `cli.js` geçenlere bakın.

### Kaldırma
```powershell
# bootstrap ile kurduysanız (hiçbir kabukta 'cd' ile app klasörüne girmeyin; Windows o klasörü silmeye izin vermez):
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\ClaudeAgent\app\scripts\uninstall.ps1" -Logout -PurgeData
# elle indirdiyseniz: proje klasöründeki scripts\uninstall.ps1 (aynı bayraklarla)
```
- Görevi siler; yalnızca bu ajanın bekçi ve ajan süreçlerini durdurur (başka Claude süreçlerine dokunmaz).
- `-Logout`: yalnızca ajanın **izole** hesabından çıkış yapar. `-PurgeData`: `%LOCALAPPDATA%\ClaudeAgent` klasörünü (giriş, token, loglar) siler. Bayraksız çalıştırırsanız veri korunur.
- Silmez: elle indirdiğiniz proje klasörü, Node.js, Claude Code, GitHub'daki kontrol deposu/issue/token ve claude.ai tarafındaki eski Remote Control oturum kaydı.

Kaldırma sonrası kontrol:
```powershell
Get-ScheduledTask ClaudePersistentAgent -ErrorAction SilentlyContinue    # çıktı vermemeli
Test-Path $env:LOCALAPPDATA\ClaudeAgent                                  # False olmalı
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'AnyDeskClaude\\(scripts|src)|ClaudeAgent' } | Select ProcessId, Name   # boş olmalı
```

| Komut | Ne yapar |
|---|---|
| `scripts\status.ps1` | Görev + ajan durumu + canlı auth |
| `scripts\stop.ps1` / `start.ps1` | Yalnızca bu ajanı durdurur / başlatır |
| `scripts\submit-code.ps1` | Telefonda alınan giriş kodunu yerelde girer |
| `scripts\set-github-token.ps1` | GitHub token'ı DPAPI ile saklar |
| `scripts\uninstall.ps1 [-Logout] [-PurgeData]` | Görevi kaldırır; isteğe bağlı izole hesaptan çıkış ve veri silme |
| `npm test` | Testler |

GitHub komutları (issue yorumunun ilk satırı; yalnızca `allowedUsers`): `/code KOD` `/login` `/cancel-login` `/status` `/restart` `/help`

## Hesap izolasyonu

- Tüm `claude` çağrıları `CLAUDE_CONFIG_DIR=%LOCALAPPDATA%\ClaudeAgent\claude-config` ile çalışır; global `~\.claude` hiç okunmaz/yazılmaz.
- Dizin `~\.claude`, kullanıcı ana dizini veya kabuktan miras alınan başka bir `CLAUDE_CONFIG_DIR` ile çakışırsa çalışmaz.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex değişkenleri alt süreçlerden silinir; abonelik dışı kimlik doğrulama reddedilir.
- Her kontrolde `auth status` içindeki `configDirectory` beklenenle karşılaştırılır. **Uyuşmazsa** ajan alt süreçlerini kapatır, GitHub'a bildirir ve **kod 3 ile çıkar; bekçi yeniden başlatmaz.**
- Süreç sonlandırma yalnızca ajanın kendi kayıtlı PID'leri içindir ve komut satırı doğrulanır (`taskkill /T` ile kendi ağacı). Başka Claude süreçlerine dokunulmaz.

## Dayanıklılık

- **Logout tespiti:** `logoutConfirmations` (2) ardışık başarısız kontrol gerekir; `auth status` çalışmazsa/bozuk çıktı verirse logout sayılmaz.
- **İnternet kesintisi:** internet yokken logout kararı verilmez (`OFFLINE`); GitHub hataları/hız sınırı geri çekilmeyle yönetilir.
- **Çökme:** `remote-control` üstel geri çekilmeyle (5 sn → 5 dk) yeniden başlar; ajan çökerse bekçi (`run.ps1`) yeniden başlatır; yarım kalan eski süreçler komut satırı doğrulanarak temizlenir.
- **Yarım kalan iş:** logout anında oturum bilgisi `state.json` → `interrupted` içine yazılır; giriş sonrası `remote-control --continue` ile son oturum yeniden bağlanır (`--continue` yaklaşık 4 saat içinde geçerlidir; olmazsa yeni oturum açılır). Konuşma kayıtları izole dizinde kalır (`claude --resume`).
- **Eski komutlar:** logout anında mevcut yorumlar “okunmuş” sayılır; eski `/login` yeniden çalışmaz. Yalnızca `allowedUsers` komut verebilir.
- **Kalıcılık:** `%LOCALAPPDATA%\ClaudeAgent\` altında `logs\` (5 MB döner, token/kod maskeleme), `state.json` (atomik), `config.json`.

## Güvenlik

- API anahtarı kullanılmaz. Token/parola GitHub'a yazılmaz. Giriş bağlantısı ve tek kullanımlık `/code` yorumu GitHub'dan geçer → depo **özel** olmalı (doğrulanır), kod hemen silinir, loglara/`state.json`'a yazılmaz.
- GitHub token'ı yalnızca o depoda Issues iznine sahip olmalı ve DPAPI ile (sadece bu Windows kullanıcısı çözebilir) saklanır.
- Claude'un kendi kimlik bilgileri yalnızca izole dizindedir; hiçbir yere kopyalanmaz.

## Doğrulama durumu

**Gerçek ortamda doğrulandı:** izole hesapla otomatik giriş akışı (bağlantı → telefondan onay → `/code KOD` → stdin → `auth status` → yorumların silinmesi); `claude remote-control`'ün TTY'siz, gizli ve güven istemi olmadan çalışması (ilk kullanım onayı `y` ile otomatik verilir); yeniden başlatınca `--continue` ile aynı oturuma bağlanma; görev/bekçi/durdurma/kaldırma akışı; "zaten kurulu" denetimi.

**Henüz doğrulanmadı:**
1. Telefondan Remote Control oturumuna komut verip çalıştırma (mesaj yerel oturuma ulaşır; yanıt kalitesi modele bağlıdır).
2. Logout → yeniden giriş → Remote Control'ün otomatik dönmesi zincirinin tamamı tek seferde.
3. Sıfır bir bilgisayarda Node.js'in `winget` ile otomatik kurulumu.
4. Çıkışın `auth status`'a yansıması: sunucu tarafında iptal edilen bir token, `remote-control` hata verene kadar `loggedIn:true` görünebilir.

**Bilinen kısıtlar:** CLI her giriş sürecinde PC'de tarayıcı açar (`BROWSER` değişkeni yok sayılır); bir giriş süreci tek kod denemesi yapar (yanlış kodda yeni bağlantı üretilir); kod, silinene kadar kısa süre özel depoda yorum olarak görünür.
