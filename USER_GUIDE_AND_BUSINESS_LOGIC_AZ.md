# AgentSpace — Biznes Məntiqi, İstifadə Ssenariləri və Məhsul Bələdçisi

> **Sənədin Məqsədi:** Layihənin texniki kodlarından asılı olmayaraq, biznes dəyərini, istifadəçinin platformada nə etdiyini, hansı problemləri həll etdiyini və tətbiqdən addım-addım necə istifadə olunacağını izah etmək.

---

## 1. Layihənin Biznes Konsepsiyası və Fəlsəfəsi

### 1.1. Ənənəvi Mühəndislikdə Hansı Problem Var?
Böyük və ya orta ölçülü İT layihələrində (məsələn, Bankçılıq, E-ticarət, SaaS) proqram arxitekturası adətən aşağıdakı xaosla qarşılaşır:
1. **"Ölü Sənədlər" Xəstəliyi:** Arxitektor Miro və ya Confluence-də gözəl diaqram çəkir. 2 ay sonra proqramçılar kodu və serverləri dəyişirlər, diaqram köhnəlir və heç kim həqiqi sistemin necə işlədiyini bilmir.
2. **Komandalararası Rabitəsizlik:** Təhlükəsizlik (Cybersecurity) komandası, Verilənlər Bazası (DBA) mühəndisi və Backend developer eyni dildə danışmır. Təhlükəsizlik xətaları ancaq sistem qəzaya uğrayanda üzə çıxır.
3. **AI Çatbotlarının Çatışmazlığı:** ChatGPT və ya Claude-a *"Sistemimiz təhlükəsizdirmi?"* deyə soruşduqda, o sizin serverlərinizin bir-birinə necə bağlandığını, kəşin harada olduğunu, şəbəkə protokollarını görmədiyi üçün ümumi və faydasız cavablar verir.

### 1.2. AgentSpace Bu Problemi Necə Həll Edir?
AgentSpace komandaya bir **"Canlı Rəqəmsal Arxitektura Qərargahı (Digital Command Center)"** verir:
* **Canlıdır:** Arxitektura diaqramı statik şəkil deyil, real konfiqurasiyaları olan interaktiv xəritədir.
* **Ağıllıdır:** Sistemdə 8 nəfərlik virtual mühəndis komandası (AI Agentlər) var — Təhlükəsizlik mütəxəssisi, Arxitektor, Baza mühəndisi, DevOps və s.
* **Təhlükəsizdir:** AI agentlər heç vaxt özbaşına sistemi dəyişə bilməz. Onlar təklif verir, insan mühəndis isə bir kliklə təsdiq edir.

---

## 2. İstifadəçi Rolları (Kimlər İstifadə Edir?)

Platforma texniki komandanın bütün üzvləri üçün nəzərdə tutulub:

1. **CTO / Baş Arxitektor (Owner / Admin):**
   - Sistemin bütöv mənzərəsinə nəzarət edir.
   - Sistem Sağlamlıq İndeksinə (Health Score) baxır.
   - AI agentlərin irəli sürdüyü struktur dəyişikliklərini (Proposals) təsdiq və ya rədd edir.
2. **Senior / Lead Developer (Editor):**
   - Yeni servislər əlavə edir, əlaqələr çəkir.
   - Servislərin texnologiyasını və parametrlərini (məsələn, Redis timeout, Kafka retry) sazlayır.
   - Mövcud `docker-compose.yml` faylını yükləyərək sistemi avtomatik xəritələndirir.
3. **Təhlükəsizlik / QA Mühəndisi (Reviewer):**
   - Agentlərə auditi başlatmaq tapşırığı verir ("Run Review").
   - Aşkarlanan təhlükəsizlik risklərini və performans boşluqlarını araşdırır.
4. **Junior Developer / Məhsul Meneceri (Viewer):**
   - Sistemin necə işlədiyini, servislərin bir-biri ilə necə əlaqə saxladığını oxuyur və öyrənir.

---

## 3. İstifadəçinin Addım-Addım Tətbiq Təcrübəsi (User Journey)

Təsəvvür edək ki, siz **ShopSphere** adlı böyük bir e-ticarət layihəsinin mühəndisisiniz. Tətbiqə daxil olanda proses belə cərəyan edir:

### Addım 1: Daxil Olma və Layihənin Açılması
* İstifadəçi brauzerdə `http://localhost:5173` ünvanına daxil olur.
* Hazır hesab ilə (`demo@agentspace.local`) sistemə girir.
* Qarşısına **ShopSphere** layihəsinin canlı arxitektura kətanı açılır.

---

### Addım 2: Canlı Kətanla İş (Architecture Canvas)
* **Xəritənin İdarəsi:** Ekranda bütün servislər görünür: `API Gateway`, `Web Frontend`, `Payment Service`, `Order Service`, `PostgreSQL`, `Kafka`, `Redis` və s.
* **İstənilən Komponentə Klikləmək:**
  - Məsələn, `Payment Service` qutusuna klikləyirsiniz.
  - Sağ tərəfdə **İnspektor Paneli** açılır:
    - Hansı dildə yazılıb? (məsələn, Node.js / Go).
    - Hansı servislərə bağlıdır? (Postgres-ə SQL ilə, Gateway-ə HTTPS ilə).
    - Bu servislə bağlı neçə dənə həll olunmamış təhlükəsizlik problemi var?
* **Real-Time Multiplayer Əməkdaşlıq:** Əgər başqa komanda yoldaşınız da eyni layihəyə daxil olubsa, onun adı və kursoru ekranda canlı hərəkət edir. O, hansı servisi seçibsə, siz də onun həmin servislə məşğul olduğunu görürsünüz.

---

### Addım 3: AI Mühəndis Otağı (Engineering Room & Conversations)
Layihənin ən güclü cəhəti burada başlayır:
1. İstifadəçi sağ tərəfdəki **"Engineering Room"** düyməsini sıxır (və ya sol menyudan **Conversations** bölməsinə keçir).
2. Çat pəncərəsi açılır. Burada komanda üzvləri və virtual AI mühəndislər birlikdə oturub müzakirə aparır.
3. **İstifadəçi sual verir:**
   > *"@SecurityAgent, bizim ödəniş (Payment) və qeydiyyat sistemimizdə hansı kritik təhlükəsizlik zəiflikləri var?"*
4. **AI Agentin Hərəkəti:**
   - Agent heç nəyi havadan uydurmur! O, sistemin canlı qrafını oxuyur (`read_architecture`), `Payment Service`-in konfiqurasiyasına baxır (`inspect_component`).
   - Görür ki: `Payment Service` bazadakı bütün cədvəllərə birbaşa çıxışa malikdir (`databaseAccess: "all tables"`), `API Gateway`-də isə `rateLimiting: false`-dur (yəni DDoS hücumuna qarşı qorunma yoxdur).
   - Agent digər agentə müraciət edir: `@DatabaseEngineer, sən ödəniş bazasının izolyasiyası üçün nə təklif edirsən?`
   - Və istifadəçiyə dəlillərə əsaslanan texniki rəy təqdim edir.

---

### Addım 4: Struktur Dəyişikliyi Təklifi (Proposals)
İstifadəçi AI-dan xahiş edir:
> *"@SystemArchitect, oxuma yükünü azaltmaq və təhlükəsizliyi artırmaq üçün bura bir kəş servisi əlavə et."*

1. **AI Agent Təklif Paketini Hazırlayır:**
   - Ekranda interaktiv bir **Təklif Kartı (Proposal Card)** peyda olur:
     - **Başlıq:** `Add Redis caching layer for Order Service`
     - **Səbəb:** Tez-tez oxunan sifariş məlumatlarını bazadan yox, kəşdən vermək.
     - **Risk Səviyyəsi:** `MEDIUM`
     - **Dəyişikliklər:**
       - `+ Yeni komponent: Redis Cache (Technology: Redis)`
       - `+ Yeni əlaqə: Order Service -> Redis Cache (Protocol: Redis)`
2. **İnsanın Qərarı (Human Control):**
   - Arxitektor bu dəyişikliyi incələyir.
   - İki seçim var: **"Apply to architecture"** (Təsdiq et) və ya **"Reject"** (İmtina et).
   - Arxitektor **Apply** düyməsini sıxdıqda, möcüzə baş verir: kətan avtomatik yenilənir, Redis kəş qutusu vizual olaraq uyğun boş yerdə yerləşdirilir və əlaqə xətləri çəkilir!

---

### Addım 5: Sistem Sağlamlıq İndeksi və Risklər (Health Score & Findings)
* Menyunun **Findings** bölməsinə keçdikdə, sistemin hazırkı vəziyyətinin qiymətləndirməsi görünür:
  - **Sistem Sağlamlıq Balı:** Məsələn, `68 / 100` (Aktiv tapıntıların sayına və ağırlığına görə).
  - Tapıntılar kateqoriyalar üzrə bölünür:
    - 🔴 **CRITICAL:** Gateway-də Rate Limiting söndürülüb (DDoS təhlükəsi).
    - 🟠 **HIGH:** Kafka-da `Dead Letter Queue` yoxdur (Uğursuz mesajlar itir).
    - 🟡 **MEDIUM:** Verilənlər bazasının replikasiyası yoxdur.
* Hər bir problemin yanında konkret tövsiyə və həll yolu göstərilir. Komanda bu problemləri həll etdikcə bal `100`-ə doğru yüksəlir.

---

### Addım 6: Müşahidə Rejimi — Real Kodla Müqayisə (Observe Mode)
Tutaq ki, DevOps və ya developerlər kodda gizlincə nəyisə dəyişiblər, amma memara deməyiblər:
1. Menyunun **Observe** bölməsinə keçirsiniz.
2. Komandanın `docker-compose.yml` və ya `package.json` faylını bura yükləyirsiniz (və ya `Load sample Compose file` düyməsini sıxırsınız).
3. Sistem manifesti skan edir və **Drift Hesabatı (Uyğunsuzluq Xəritəsi)** verir:
   - ⚠️ **Dizaynda var, amma kodda yoxdur:** Məsələn, siz diaqramda `Elasticsearch` çəkmisiniz, amma Docker faylında o yoxdur.
   - ⚠️ **Kodda var, amma dizaynda yoxdur:** Məsələn, kimsə gizlincə `RabbitMQ` qaldırıb, amma arxitekturada qeyd etməyib.
4. İstifadəçi bir kliklə aşkar edilmiş komponentləri kətana daxil edə bilər. Beləliklə, sənəd heç vaxt köhnəlmir!

---

### Addım 7: Tarixçə və Sənədlər (History & Artifacts)
* **History:** Kim nə vaxt nəyi dəyişdi? Bütün versiyalar arxivdə saxlanılır. Əgər kimsə səhv nəsə çəkibsə, bir kliklə dünənki versiyaya qayıtmaq (Rollback) mümkündür.
* **Artifacts & Knowledge:** AI agentlər tərəfindən yazılmış texniki sənədlər (ADR - Architecture Decision Records, qəza bərpa planları, təhlükəsizlik auditi hesabatları) burada səliqəli saxlanılır və istənilən vaxt ixrac (export) edilə bilər.

---

## 4. İstifadəçi İnterfeysinin (UI) Əsas Bölmələri

| Bölmə Adı | İkon | İstifadəçinin Burada Etdiyi Əsas İş |
| :--- | :---: | :--- |
| **Inbox** | 🔔 | Fərdi bildirişlər: təsdiq gözləyən təkliflər, kritik təhlükəsizlik xəbərdarlıqları və sizə ünvanlanan `@mentions`. |
| **Conversations** | 💬 | Dust-style müzakirə axınları. Həm insanlarla, həm də süni intellekt mütəxəssisləri ilə söhbət və beyin fırtınası. |
| **Architecture** | 🗺️ | Əsas interaktiv kətan. Komponentləri sürükləmək, əlaqələr qurmaq, konfiqurasiya yazmaq. |
| **Observe** | 📡 | Docker Compose və manifestləri yükləyərək real infrastrukturla dizayn arasındakı fərqi tapmaq. |
| **Agents** | 🤖 | 8 virtual mühəndisin tənzimlənməsi (təlimatlarını dəyişmək, hansı LLM modelini istifadə edəcəyini seçmək). |
| **Review Tasks** | 📋 | Tək kliklə sistemin bütöv auditini başlatmaq ("Run Review"). |
| **Artifacts** | 📖 | Texniki sənədlər, arxitektura qərar qeydləri (ADR), spesifikasiyalar. |
| **Knowledge** | 📄 | Layihəyə aid şirkət daxili qaydaları və standartları mətn şəklində sistemə yükləmək. |
| **Findings** | 🛡️ | Təhlükəsizlik, dayanıqlıq və performans riskləri; Sistem Sağlamlıq Balı (Health Score). |
| **Proposals** | 🔀 | AI tərəfindən hazırlanmış dəyişiklik paketləri (qəbul et / rədd et). |
| **Activity** | 📈 | Layihə daxilində baş verən bütün hərəkətlərin canlı lenti. |
| **History** | ⏳ | Arxitekturanın keçmiş versiyaları və bir kliklə bərpa (Restore). |

---

## 5. Nəticə: Bu Platforma Biznesə Nə Qazandırır?

1. **Xətaların Erkən Mərhələdə Qarşısının Alınması:** İstehsalata (Production) getməzdən əvvəl arxitekturadakı zəif nöqtələr (DDoS riski, tək nasazlıq nöqtəsi, məlumat sızması) virtual mütəxəssislər tərəfindən aşkar edilir.
2. **Komandanın Sürətlənməsi:** Yeni işə başlayan proqramçı Miro diaqramları axtarmaq əvəzinə AgentSpace-ə girir, canlı sistemi görür və `@SystemArchitect`-dən sistemin necə işlədiyini soruşur.
3. **Arxitektura İntizamı:** Heç bir dəyişiklik nəzarətsiz qalmır; hər bir addım sənədləşdirilir, audit olunur və komanda rəhbərinin təsdiqi ilə tətbiq edilir.
