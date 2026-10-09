# AgentSpace (AiSpacePlatform) — Layihənin Hərtərəfli Texniki və Arxitektur Analizi

> **Müəllif:** Senior Software Architect / Staff Engineer Analizi  
> **Tarix:** Oktyabr 2026  
> **Hədəf Auditoriya:** Mühəndislər, Texniki Liderlər, Arxitektorlar və Məhsul Sahibləri  
> **Dil:** Azərbaycan dili  

---

## 1. Giriş və Layihənin Ümumi Təyinatı

### 1.1. AgentSpace Nədir?
**AgentSpace** — proqram təminatının **canlı arxitekturası (live software architecture)** ətrafında təşkil olunmuş, çoxistifadəçili (multiplayer) mühəndislik və arxitektura idarəetmə platformasıdır. Layihə statik diaqram çəkmə aləti deyil; o, real kod, asılılıqlar və infrastruktur manifestləri ilə sinxronlaşan, daxilində ixtisaslaşmış AI mühəndis agentləri saxlayan və insan nəzarətində (Human-in-the-Loop) dəyişikliklər edən tamfunksiyalı şaquli MVP (Vertical Minimum Viable Product) sistemidir.

### 1.2. Həll Etdiyi Əsas Problemlər
1. **Arxitektura Çürüməsi və Sxem Köhnəlməsi (Architecture Drift & Stale Docs):**  
   Ənənəvi mühəndislik komandalarında arxitektura diaqramları (Confluence, Miro, Lucidchart) kod yazıldıqdan sonra unudulur və həqiqi sistemlə aralarındakı uçurum böyüyür. AgentSpace manifestləri (`docker-compose.yml`, `package.json`, `requirements.txt`) oxuyaraq mövcud dizaynla faktiki tətbiq arasındakı fərqi (drift) avtomatik aşkar edir.
2. **AI-ın Kontekstsizliyi və Halüsinasiyası:**  
   Tipik süni intellekt çatbotları sistemin tam topologiyasını, asılılıqlarını və təhlükəsizlik qaydalarını bilmir. AgentSpace-də hər bir AI agent layihə qrafına, komponent parametrlərinə, əvvəlki qərarlara və sənədlərə dəqiq icazələrlə (Scoped Tool Calling) çıxış əldə edir.
3. **Nəzarətsiz AI Dəyişiklikləri Riski:**  
   Süni intellekt heç bir halda arxitekturaya birbaşa, gizli və ya dağıdıcı dəyişiklik edə bilməz. Bütün dəyişikliklər **Təklif (Proposal)** formasında təqdim edilir və yalnız layihənin səlahiyyətli mühəndisi (Owner/Admin) tərəfindən təsdiqləndikdə atomik olaraq tətbiq olunur.

---

## 2. Texnologiya Steki (Technology Stack)

Sistem yüksək etibarlılıq, tip təhlükəsizliyi və minimum xarici asılılıq prinsipi ilə qurulmuşdur:

| Təbəqə | Texnologiya | Seçim Səbəbi və Üstünlüyü |
| :--- | :--- | :--- |
| **Backend Framework** | **Fastify 5.x** (Node.js >= 22.12) | Yüksək performans, az overhead, daxili plugin arxitekturası, asan WebSocket inteqrasiyası və güclü HTTP təhlükəsizliyi. |
| **Məlumat Bazası (Database)** | **PostgreSQL** & **PGlite** (Embedded) | Əsas mənbə (Single Source of Truth). Lokal rejimdə `@electric-sql/pglite` vasitəsilə Postgres mühərriki heç bir quraşdırma tələb etmədən WebAssembly/C səviyyəsində işləyir. İstehsalatda isə real Postgres istifadə olunur. |
| **SQL & Miqrasiyalar** | **Təmiz Parametrləşdirilmiş SQL (`pg`)** | ORM qatının (Prisma, TypeORM) yaratdığı gizli sorğu problemlərindən qaçmaq, tranzaksiya izolyasiyasını (`FOR UPDATE` kilidləri) və kaskad əlaqələrini tam idarə etmək üçün. Miqrasiyalar nömrələnmiş SQL faylları ilə idarə olunur. |
| **Frontend Framework** | **React 19 + TypeScript + Vite 8** | Sıx və zəngin interaktiv interfeys, müasir React hook-ları və yüksək inkişaf sürəti. |
| **Qraf Kətanı (Graph Canvas)** | **@xyflow/react (React Flow 12)** | Node-Edge əsaslı böyük sistem qraflarını pan/zoom, sürükləmə, fərdiləşdirilmiş vizual komponentlər və mini-xəritə ilə render etmək üçün standart alət. |
| **Vəziyyət İdarəetməsi (State)**| **@tanstack/react-query 5** | Server məlumatlarının keşlənməsi, fon yenilənmələri, mutasiyalar və optimist yenilənmələr üçün. |
| **Real-Time Əlaqə** | **Native WebSocket (`@fastify/websocket`)** | Canlı istifadəçi varlığı (presence), kursor koordinatları, seçilmiş komponentlər və qraf yenilənmə siqnalları (`invalidate`) üçün. |
| **Validasiya & Sxemlər** | **Zod 4.x** | Həm server, həm klient, həm də LLM Tool Calling çıxışları üçün ortaq (isomorphic) tip təhlükəsizliyi müqavilələri. |
| **AI / LLM İnteqrasiyası** | **Multi-Provider Adapter (OpenAI, Anthropic, Google, Local Rules)** | OpenAI Responses API ilə `strict: true` strukturlaşdırılmış Tool Calling, eləcə də oflayn işləyən deterministik lokal qaydalar mühərriki. |
| **Dizayn və Stil** | **Vanilla CSS (Design Tokens, Dark/Light)** | CSS modulları və qlobal dizayn sistem dəyişənləri ilə sıfır asılılıqlı, yüngül və ultra-sürətli render. |
| **Testlər** | **Vitest + Playwright** | Vahid/inteqrasiya testləri (in-memory Postgres ilə) və ikibrauzerli multiplayer E2E testləri. |

---

## 3. Sistem Arxitekturası və İşləmə Mexanizmi

Sistem klassik **Modular Monolith** modelində dizayn edilmişdir. Bütün komponentlər tək bir Node.js prosesində səliqəli sərhədlərlə ayrılmışdır.

```
                           +------------------------------------------------+
                           |           Brauzer (React 19 + React Flow)      |
                           +------------------------------------------------+
                                   | HTTP (Sessions/JSON)          ^ WebSocket
                                   v                               | (Presence/Invalidate)
        +-------------------------------------------------------------------------+
        | Fastify Tətbiq Qatı (Modular Monolith)                                  |
        |                                                                         |
        |  [Auth & RBAC] ----> [Routes / APIs] ----> [Realtime Hub (WebSockets)]  |
        |                            |                                            |
        |                            v                                            |
        |                 [Graph Service / Revision]                              |
        |                            |                                            |
        |                            v                                            |
        |                [PostgreSQL / PGlite DB] <----+                          |
        |                            |                 |                          |
        |                            v                 |                          |
        |                  [Durable Event Outbox]      |                          |
        |                            |                 |                          |
        |                            v                 |                          |
        |                 [Bounded Agent Worker]       |                          |
        |                            |                 |                          |
        |           +----------------+---------------+ |                          |
        |           |                |               | |                          |
        |     [Context Builder] [Tool Registry] [Providers]                       |
        |     (Graph/Knowledge) (Read/Write)    (OpenAI/Anthropic/Google/Local)  |
        +-------------------------------------------------------------------------+
```

### 3.1. Əsas Relyasion Məlumat Modeli (Data Schema)
Məlumat bazası güclü referensial bütövlük (Referential Integrity) və layihə səviyyəsində təcrid olunma (Tenant Isolation) prinsipləri ilə qurulub:

1. **Kimlik və İcazələr (Identity & Access):**
   - `users`: İstifadəçi qeydiyyatı, Scrypt heşləri, OIDC subyekti.
   - `sessions`: Yalnız SHA-256 heşi saxlanılan 256-bit təhlükəsiz sessiya tokenləri.
   - `workspaces` & `workspace_members`: Təşkilat səviyyəli sahiblik və rollar.
   - `projects` & `project_members`: Layihə səviyyəsində 5 səlahiyyət rolu (`OWNER`, `ADMIN`, `EDITOR`, `REVIEWER`, `VIEWER`).
   - `invitations`: Birdəfəlik kriptoqrafik dəvət linkləri.
2. **Arxitektura Qrafı (Architecture Domain):**
   - `components`: Node-lar (`id`, `project_id`, `name`, `category`, `technology`, `x`, `y`, `config` JSONB).
   - `edges`: Yönləndirilmiş əlaqələr (`source`, `target`, `protocol`, `metadata` JSONB). Komponent silindikdə əlaqələr kaskad olaraq avtomatik silinir.
   - `architecture_versions`: Monoton artan hər layihə reviziyasında (`revision`) qrafın tam JSON snapshotu və müəllifi.
   - `architecture_views`: Kateqoriyalar üzrə proyeksiya filtrləri.
3. **AI Agentlər və Alətlər:**
   - `agents`: Hər layihə üçün konfiqurasiya edilə bilən agent profilləri (sistem təlimatları, provayder, model).
   - `agent_tool_grants`: Hansı agentin hansı resurs üzərində hansı aləti icra edə biləcəyini təyin edən qranulyar icazə matrisi (`AUTO`, `APPROVAL_REQUIRED`, `DISABLED`).
   - `agent_runs`: İcra növbəsi və statusu (`queued`, `running`, `completed`, `failed`).
   - `tool_executions`: Agentlərin icra etdiyi hər bir alət addımının giriş/çıxış xülasəsi və müddəti.
4. **Əməkdaşlıq və Qərarlar:**
   - `conversations` & `messages`: Dust üslubunda layihə daxili çoxistifadəçili müzakirə axınları və agent cavabları.
   - `comments`: Komponent səviyyəsində kontekstual şərhlər.
   - `findings`: Dəlillərə (`evidence`) və inam dərəcəsinə (`confidence >= 0.65`) əsaslanan arxitektura qüsurları və risklər.
   - `proposals`: Agentlər tərəfindən irəli sürülən struktur və ya konfiqurasiya dəyişiklikləri paketi.
   - `audit_logs`: Bütün hərəkətlərin dəyişməz (immutable) audit jurnalı.
   - `knowledge_sources`: Layihəyə aid əlavə mətn/sənəd kontekstləri.
   - `artifacts`: Agentlər və insanlar tərəfindən yaradılan Markdown sənədləri (ADR, icmal, plan, runbook).

---

### 3.2. Real-Time Sinxronizasiya və Tranzaksiya Mexanizmi (Concurrency Control)
AgentSpace bir neçə mühəndisin eyni vaxtda işləməsi zamanı məlumatların itməməsini təmin etmək üçün **Optimistik Versiya Yoxlaması və Pessimistik Sətir Kilidi (Optimistic Concurrency with Row-level Lock)** kombinasiyasından istifadə edir:

1. **Mutasiya Sorğusu:** İstifadəçi qrafda hər hansı dəyişiklik edəndə (məsələn, komponentin yerini dəyişdikdə və ya yeni servis əlavə etdikdə), klient oxuduğu cari `revision` nömrəsini və mutasiyalar siyahısını göndərir (`POST /api/projects/:id/graph`).
2. **Pessimistik Kilidləmə:** Backend tranzaksiya açır və layihə cərgəsini dərhal kilidləyir:
   ```sql
   SELECT revision FROM projects WHERE id = $1 FOR UPDATE;
   ```
3. **Versiya Uyğunluğu:** Əgər `project.revision !== request.revision` olarsa, sistem dərhal **`409 Conflict`** xətası qaytarır. Bu, iki mühəndisin bir-birinin işini səssizcə əzməsinin (silent overwrite) qəti şəkildə qarşısını alır.
4. **Atomik Tətbiq və İnkremasiya:** Mutasiyalar Zod sxemləri ilə yoxlanılır, bazaya yazılır, layihənin reviziya nömrəsi 1 vahid artırılır, versiya snapshot-u və audit log eyni tranzaksiyada saxlanılır.
5. **WebSocket İnvalidasiyası:** Tranzaksiya commit olunduqdan sonra `RealtimeHub` bütün qoşulmuş brauzerlərə yüngül `{ type: "invalidate" }` siqnalı göndərir.
6. **Avtomatik Refetch:** Klientlər heç vaxt WebSocket üzərindən birbaşa səlahiyyətli verilənlər qəbul etmirlər; onlar invalidasiya siqnalını aldıqda təhlükəsiz HTTP snapshot API-dən ən son reviziyanı təkrar çəkirlər.

---

### 3.3. Süni İntellekt Mühərriki (Bounded Agent Runtime)

AgentSpace-in süni intellekt arxitekturası **idarə olunan, sərhədləri müəyyən edilmiş (bounded) və təhlükəsiz** prinsiplərə əsaslanır:

```
[İstifadəçi @Mention / Review Task]
                |
                v
       +-----------------+
       |  enqueueRun()   |  <--- (Paralel işləmə məhdudiyyəti: Layihə üzrə tək aktiv run)
       +-----------------+
                |
                v
       +-----------------+
       | Context Builder |  <--- Qraf qonşuluğu, sənədlər, son müzakirələr, qaydalar
       +-----------------+
                |
                v
   +---> [Agent Turn (Məs: Architect)]
   |            |
   |            v  (Tool Calls dövrəsi: maks 12 addım)
   |     +--------------+
   |     | Execute Tool |  <--- inspect_component, search_project, propose_change, record_finding...
   |     +--------------+
   |            |
   |            v
   |     [Yoxlama & Nəticə]
   |            |
   |            +-----------------------+
   |            |                       |
   |      (Növbəti Alət)         (Yekun Çıxış / Cavab)
   |                                    |
   |                                    v
   |                        [Delegation Yoxlaması]
   |                       (ask_agent: Məs: @Security)
   |                                    |
   +------------------------------------+ (Maksimum 5 agent, dərinlik: 2)
```

#### İcra Məhdudiyyətləri (Hard Guardrails):
- **Tək Aktiv İcra:** Eyni layihədə eyni vaxtda yalnız bir aktiv agent işi gedə bilər (Məlumat bazasında partial unique index ilə qorunur: `CREATE UNIQUE INDEX one_active_run ON agent_runs(project_id) WHERE status IN ('queued','running')`).
- **Turn və Dərinlik Limiti:** Bir işdə maksimum 5 fərqli agent iştirak edə bilər, hər biri 1 dəfə çıxış edir. Nümayəndəlik dərinliyi (delegation depth) maksimum 2 ola bilər.
- **Addım Limiti:** Agent bir çıxışında ən çox 12 alət addımı ata bilər (`MAX_STEPS_PER_TURN = 12`).
- **Token Büdcəsi:** Standart olaraq bir icra üçün maksimum 250,000 token limiti tətbiq olunur (`AGENT_RUN_TOKEN_LIMIT`).
- **Vaxt Aşımı (Timeout):** Hər bir LLM çağırışı 60 saniyə ilə məhdudlaşdırılır.

#### Təqdim Edilən Alətlər (Agent Tools):
1. `read_architecture`: Layihənin bütün komponentlərini və əlaqələrini oxuyur.
2. `inspect_component`: Seçilmiş komponentin konfiqurasiyasını, daxil olan və çıxan əlaqələrini, açıq tapıntılarını və şərhlərini əldə edir.
3. `search_project`: Komponentlər, tapıntılar, qərarlar və sənədlər üzrə açar sözlə axtarış aparır.
4. `read_artifact`: Layihə sənədinin tam mətnini oxuyur.
5. `propose_change`: Arxitekturaya dəyişiklik təklifi irəli sürür (yeni komponent, konfiqurasiya dəyişikliyi və s.). İnsan təsdiq edənə qədər qrafa tətbiq olunmur.
6. `record_finding`: Dəlillərə əsaslanan texniki tapıntı qeyd edir (inam dərəcəsi `0.65`-dən aşağı olduqda qəbul edilmir).
7. `write_artifact`: ADR (Architecture Decision Record), icmal, plan və ya texniki spesifikasiya yazır.
8. `ask_agent`: Digər ixtisaslaşmış agentə (məsələn, `@security` və ya `@database`) sual ünvanlayır.

---

### 3.4. Semantik Əməliyyatlar və Təkliflərin Rebase Olunması (Semantic Proposals)

Ənənəvi diff alətləri koordinat və ya indeks dəyişdikdə korlanır. AgentSpace-də agentlərin təklifləri **semantik əməliyyatlar (Semantic Operations)** kimi kodlaşdırılır:
- `add_component`: Müvəqqəti `ref` identifikatoru ilə yeni servis təyin edir.
- `update_component`: Konkret sahələri və ya konfiqurasiya açarlarını dəyişir.
- `remove_component`: Komponenti silir.
- `add_connection` & `remove_connection`: Əlaqələri idarə edir.

**Ağıllı Rebase Mexanizmi:**  
Əgər agent təklif hazırladıqdan sonra insan mühəndis arxitekturada başqa bir dəyişiklik edibsə (yəni layihənin `revision` nömrəsi artıbsa), təklif dərhal ləğv edilmir! Təsdiqləmə (Approval) zamanı sistem semantik əməliyyatları yeni qraf üzərində yenidən yoxlayır (`operationsToMutations`). Əgər ziddiyyət (məsələn, silinmiş komponentə bağlanma cəhdi və ya ad toqquşması) yoxdursa, təklif yeni arxitekturaya problemsiz tətbiq edilir.

---

### 3.5. Müşahidə və Sxem Uyğunsuzluğu Analizi (Observe Mode & Drift Detection)

Platformanın ən güclü cəhətlərindən biri mövcud manifestlərin təhlilidir:
- **Dəstəklənən Formatlar:** `docker-compose.yml`, `package.json`, `requirements.txt`.
- **Statik Analiz Qaydaları:** `server/discovery.ts` faylı manifestləri oxuyaraq imicləri (`postgres`, `redis`, `kafka`, `nginx`, `keycloak` və s.) və ya asılılıq kitabxanalarını (`pg`, `ioredis`, `stripe`, `openai`, `sentry`) aşkarlayır.
- **Təhlükəsizlik:** Ətraf mühit dəyişənlərinin (`environment`) daxilindəki şifrələr və gizli açarlar heç vaxt yadda saxlanılmır və qaytarılmır; yalnız servis adları və struktur analiz edilir.
- **Drift Hesabatı (Designed vs Observed):**
  - *Designed-but-unobserved:* Dizaynda çəkilmiş, lakin Compose və ya asılılıqlarda tapılmayan komponentlər və əlaqələr.
  - *Observed-but-undeclared:* Faktiki manifestdə mövcud olan, lakin arxitektura sxeminə əlavə edilməmiş komponentlər.
  - Hər bir müşahidə layihənin bilik bazasına (`knowledge_sources`) daxil edilir ki, agentlər analiz zamanı bu uyğunsuzluqları nəzərə ala bilsinlər.

---

## 4. Təhlükəsizlik və İcazələr Modeli (RBAC & Security)

Layihədə çoxpilləli təhlükəsizlik modeli həyata keçirilmişdir:

### 4.1. Rol Əsaslı Giriş Nəzarəti (RBAC Matrix)

| Əməliyyat | VIEWER | REVIEWER | EDITOR | ADMIN / OWNER |
| :--- | :---: | :---: | :---: | :---: |
| Qrafı, tapıntıları, müzakirələri oxumaq | Bəli | Bəli | Bəli | Bəli |
| Müzakirədə yazmaq / Şərh bildirmək | Xeyr | Bəli | Bəli | Bəli |
| Rəy başlatmaq (Run Review) / Tapıntını həll etmək | Xeyr | Bəli | Bəli | Bəli |
| Qrafı birbaşa redaktə etmək / İdxal / Görünüş yaratmaq | Xeyr | Xeyr | Bəli | Bəli |
| **Arxitektura təklifini təsdiq/rədd etmək (Approve/Reject)** | **Xeyr** | **Xeyr** | **Xeyr** | **Bəli** |
| Komanda üzvü dəvət etmək / Rol dəyişmək / Agent sazlamaq | Xeyr | Xeyr | Xeyr | Bəli |

### 4.2. Şəbəkə və Sessiya Təhlükəsizliyi
- **Sessiyalar:** 256-bit təsadüfi tokenlər. Bazada yalnız onların SHA-256 heşləri saxlanılır. Cookie parametrləri: `HttpOnly`, `SameSite=Lax`, istehsalatda `Secure`.
- **Şifrələmə:** Scrypt alqoritmi ilə unikal duzlanmış (salted) heşlər.
- **CSRF və Mənşə Doğrulaması:** Bütün mutasiya sorğularında `X-AgentSpace-Request: 1` başlığı tələb olunur və brauzerin `Origin` başlığı yoxlanılır.
- **Rate Limiting:** IP və sessiya əsaslı müraciət limitləri (`@fastify/rate-limit`).
- **SQL Injection Müdafiəsi:** Bütün SQL sorğuları 100% parametrləşdirilmişdir (`$1, $2, ...`).

---

## 5. İstifadəçi Bələdçisi: Sistemdən Necə İstifadə Etməli?

### 5.1. Layihənin Lokal İşə Salınması

Sistemi işə salmaq üçün yalnız **Node.js 22.12+** tələb olunur (Docker və ya PostgreSQL quraşdırmaq məcburi deyil):

```bash
# 1. Asılılıqları quraşdırın
npm ci

# 2. Ətraf mühit konfiqurasiyasını köçürün
# Windows PowerShell-də:
Copy-Item .env.example .env

# 3. Məlumat bazasını ilkin məlumatlarla doldurun (PGlite daxili bazasında)
npm run db:seed

# 4. Tətbiqi inkişaf rejimində başladın (Həm Fastify server, həm Vite UI)
npm run dev
```

Brauzerdə **http://localhost:5173** ünvanını açın və hazır demo hesabla daxil olun:
- **E-poçt:** `demo@agentspace.local`
- **Şifrə:** `ShopSphere-local-2026!`

*(Qeyd: Əgər real OpenAI agentlərindən istifadə etmək istəyirsinizsə, `.env` faylında `OPENAI_API_KEY` parametrini qeyd edin).*

---

### 5.2. Əsas İstifadə Ssenariləri və İnterfeys Bölmələri

Tətbiqə daxil olduqda sol naviqasiya panelində və yuxarı idarəetmə menyusunda aşağıdakı əsas səhifələr yer alır:

#### 1. Arxitektura Kətanı (Architecture Canvas)
- **Komponentlərin İdarəsi:** Yuxarıdakı `Add component` düyməsi ilə yeni servis əlavə edin (məsələn, API Gateway, PostgreSQL, Kafka).
- **Əlaqələrin Çəkilməsi:** Komponentin sağ tərəfindəki dairədən digər komponentin sol tərəfinə ox çəkərək əlaqə qurun, protokolunu (HTTPS, gRPC, SQL və s.) təyin edin.
- **İnspektor Paneli (Inspector):** İstənilən komponentə kliklədikdə sağ tərəfdə onun texnologiyası, konfiqurasiya açarları (`rateLimiting`, `timeout`, `databaseAccess`), həmin komponentə aid açıq risklər və müzakirələr açılır.
- **Kateqoriya Görünüşləri (Views):** Arxitekturanı Backend, Frontend, Database və ya Data axını üzrə filtrləyib fokuslanmış şəkildə araşdırın.

#### 2. Çoxistifadəçili Müzakirələr və Agent Otağı (Conversations & Engineering Room)
- Sağ tərəfdəki `Engineering room` düyməsini sıxaraq kətanın yanında canlı müzakirə pəncərəsini açın.
- **Agentləri Çağırmaq:** `@SystemArchitect`, `@SecurityAgent`, `@DatabaseEngineer` və ya `@DevOpsEngineer` yazaraq arxitektura haqqında sual verin (məsələn: *"Bu arxitekturada tək nasazlıq nöqtəsi (SPOF) haradadır?"* və ya *"Ödəniş servisi üçün kəşləmə əlavə et"*).
- Agent dərhal layihə qrafını oxuyacaq, digər mütəxəssis agentlərlə məsləhətləşəcək və strukturlaşdırılmış cavab verəcək.

#### 3. Təkliflərin İdarə Edilməsi (Proposals)
- Əgər agent arxitekturaya dəyişiklik məsləhət görürsə, interfeysdə **Proposal Card** yaranır.
- Kart daxilində:
  - Dəyişikliyin səbəbi (Reason),
  - Risk səviyyəsi (Low / Medium / High),
  - Kompromislər (Tradeoffs),
  - Dəqiq əməliyyatlar (məsələn: `Add Redis cache`, `Connect Payment -> Redis via Redis protocol`).
- **Tətbiq və ya İmtina:** Layihənin Admin/Owner istifadəçisi `Apply to architecture` düyməsini sıxdıqda qraf bir saniyə ərzində avtomatik yenilənir və kətanda yeni komponentlər peyda olur. `Reject` edildikdə arxitektura toxunulmaz qalır.

#### 4. Tapıntılar və Sistem Sağlamlığı (Findings & Health Score)
- `Findings` bölməsində agentlərin aşkar etdiyi təhlükəsizlik, performans və etibarlılıq qüsurları siyahılanır.
- Hər tapıntının real dəlili (`evidence`) göstərilir (məsələn: *"Payment servisi verilənlər bazasındakı bütün cədvəllərə birbaşa çıxışa malikdir"*).
- `Health Score`: Tapıntıların ciddiliyinə (`CRITICAL: -20`, `HIGH: -10`, `MEDIUM: -5`, `LOW: -2`) əsasən sistemin ümumi sağlamlıq indeksi (0-100) hesablanır. Qüsurlar həll edildikdə xal yüksəlir.

#### 5. Müşahidə və Sxem Uyğunsuzluğu (Observe Mode)
- `Observe` bölməsinə keçin.
- `Load sample Compose file` düyməsini sıxın və ya öz layihənizin `docker-compose.yml` faylını yükləyin.
- Sistem manifesti təhlil edərək sol tərəfdə dizaynla müqayisəli drift hesabatı təqdim edəcək. Buradan birbaşa aşkar edilmiş yeni servisləri arxitekturaya daxil edə bilərsiniz.

#### 6. Versiya Tarixçəsi (History)
- Arxitekturada edilən hər bir dəyişiklik versiyalaşdırılır.
- İstənilən vaxt `History` bölməsinə daxil olaraq əvvəlki versiyalara baxa və bir kliklə layihəni keçmiş vəziyyətinə geri qaytara (Rollback/Restore) bilərsiniz.

---

## 6. Senior Developer Gözü ilə Qiymətləndirmə (Architect Review)

### 6.1. Güclü Cəhətlər (Architectural Highlights)
1. **Zero-Magic Data Layer:** Əksər müasir layihələrdə rast gəlinən qarışıq ORM və abstraction qatlarından imtina edilərək təmiz SQL və aydın tranzaksiya idarəetməsindən istifadə olunub. Concurrency race-condition halları bazanın `FOR UPDATE` mexanizmi ilə kökündən həll edilib.
2. **Zero-Setup Local Experience:** `@electric-sql/pglite` istifadəsi mühəndis üçün işə başlama baryerini sıfıra endirir. Docker və ya xarici Postgres servisi olmadan bütün münasibətlər, foreign key-lər və JSONB indeksləri yerli qovluqda işləyir.
3. **Deterministik AI Sərhədləri:** AI-ın sonsuz dövrəyə düşməsi, xərcləri şişirtməsi və ya icazəsiz hərəkət etməsi memarlıq səviyyəsində fiziki olaraq məhdudlaşdırılıb. İnsan nəzarəti prinsipi qüsursuz qurulub.
4. **Semantik Rebase İdeyası:** Təkliflərin sadə diff deyil, məntiqi əməliyyatlar kimi saxlanılması və arxitektura dəyişdikdə yenidən tətbiq edilə bilməsi yüksək səviyyəli proqram mühəndisliyi nümunəsidir.

### 6.2. Gələcək İnkişaf və Təkmilləşdirmə Sahələri (Roadmap / Gaps)
1. **Üfüqi Miqyaslanma (Horizontal Scaling):** Hazırkı arxitekturada `RealtimeHub` və `AgentRuntime` tək bir Node.js instansiyası daxilində yaddaşda (in-memory) işləyir. Sistemi bir neçə Kubernetes pod-unda işlətmək üçün Redis Pub/Sub və paylanmış kilidlər (Distributed Leases / Redlock) tətbiq olunmalıdır.
2. **CRDT və Offline Dəstək:** Çoxistifadəçili mətn redaktəsi və ya oflayn rejim üçün Yjs/CRDT texnologiyası tətbiq edilə bilər (hazırda optimist HTTP sorğusu istifadə olunur).
3. **Canlı Telemetriya İnteqrasiyası:** Hazırkı müşahidə yalnız statik manifestlərə əsaslanır. Gələcəkdə OpenTelemetry, Kubernetes API və ya Prometheus-a qoşularaq real vaxtda çalışan servislərin trafikini çəkmək platformanı tamamlayacaq.

---

## 7. Xülasə

**AgentSpace**, süni intellektin mühəndislik komandalarına necə inteqrasiya olunmalı olduğunu göstərən nümunəvi bir layihədir. O, "sadəcə bir AI çatbotu" deyil, proqram təminatı sistemlərinin mürəkkəb xəritəsini canlı saxlayan, komanda daxilində şəffaflığı təmin edən və arxitektura qərarlarını sənədləşdirib audit edən güclü bir **multiplayer mühəndislik platformasıdır**.
