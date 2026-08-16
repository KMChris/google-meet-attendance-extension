# Narzędzia deweloperskie

Dwa narzędzia, oba uruchamiane przez `npm` z katalogu repozytorium: pakowanie rozszerzenia do
Chrome Web Store i generowanie materiałów do listingu. Samo rozszerzenie nadal nie ma kroku
budowania ani żadnej zależności — `package.json` w katalogu głównym istnieje wyłącznie dla tego,
co jest tutaj.

| Polecenie | Działanie |
| --- | --- |
| `npm run package` | pakuje rozszerzenie do `dist/<nazwa>-<wersja>.zip` |
| `npm run screenshots` | generuje komplet materiałów do `dist/assets/pl` i `dist/assets/en` |
| `npm run serve` | sam serwer demonstracji, do oglądania i poprawiania kadrów ręcznie |
| `npm test` | testy rozszerzenia (`tests/`) |
| `npm run test:tools` | testy narzędzi (`tools/tests/`) |
| `npm run test:all` | jedno i drugie |

Wszystko, co narzędzia wytwarzają, trafia do `dist/`, które jest wykluczone z repozytorium.
Jednorazowo potrzebne jest `npm install` — pobiera `puppeteer-core`, wyłącznie na potrzeby zrzutów.

## Paczka do Chrome Web Store

```bash
npm run package
```

Nazwa pliku składa się sama: człon z `extName` w katalogu `en`, wersja z `manifest.json`. Po
podbiciu wersji nie trzeba niczego zmieniać — `manifest.json` jest jedynym miejscem, gdzie wersja
jest zapisana, `package.json` celowo jej nie powtarza.

Do paczki wchodzi śledzona zawartość `_locales/`, `dashboard/`, `icons/`, `report/` i `src/`.
Testy, dokumentacja, te narzędzia i strony serwisu zostają poza nią. Źródła jadą bez zmian; jedyna
poprawka dotyczy manifestu, z którego usuwany jest `key` — ta linia przypina identyfikator
lokalnej kopii rozpakowanej, a sklep nadaje własny.

Skrypt woli nie zapisać paczki, niż zapisać zepsutą. Przerywa, gdy `oauth2.client_id` jest wciąż
zaślepką (tak wygląda kopia w repozytorium), gdy manifest wskazuje plik, którego w paczce nie ma,
albo gdy w którymś katalogu `_locales` brakuje klucza `__MSG_`, o który manifest prosi. Plik
nieśledzony w katalogach rozszerzenia jest zgłaszany jako ostrzeżenie — bez tego wypadłby z paczki
po cichu.

Archiwum jest powtarzalne: ten sam stan repozytorium daje bajt w bajt ten sam plik.

## Materiały do listingu

Pakiet powstaje z deterministycznych danych demonstracyjnych o dacie odniesienia **14 sierpnia
2026**: 12 spotkań, 22 fikcyjne osoby, 3 cykle szkoleniowe i średnia frekwencja 91%. Dane są
odseparowane od prawdziwego magazynu rozszerzenia, a demonstracja nigdy nie łączy się z Google.

Każda sesja ma własny temat zamiast numeru modułu („Prompty w codziennej pracy”, „Raporty bez
pracy ręcznej”), a tematy jednego cyklu układają się w spójny kurs. Wersja angielska ma własną
obsadę — angielskie imiona i nazwiska oraz adresy z nich wyprowadzone — obsadzoną na tych samych
miejscach, więc obie wersje pokazują dokładnie te same wejścia, wyjścia i procenty.

```bash
npm run screenshots
```

Powstają 32 pliki: po 14 kadrów 1280 × 800 i 2 materiały promocyjne w `dist/assets/pl` i
`dist/assets/en`.

Opcje przekazuje się po `--`, na przykład `npm run screenshots -- --lang=pl --only=01,05`:

| Opcja | Działanie |
| --- | --- |
| `--lang=pl` | tylko jeden język (domyślnie oba) |
| `--only=01,05` | tylko wybrane kadry po numerze |
| `--clean` | usuwa z folderu językowego pliki spoza aktualnego zestawu |
| `--port=4188` | port serwera demonstracji na czas przebiegu |

Wymagania: zainstalowany Chrome — wykrywany automatycznie, inną lokalizację wskaże `CHROME_PATH`.
Jest to jedyna rzecz, której narzędzie nie instaluje samo.

### Czego pilnuje skrypt

Wymagania, które wcześniej trzeba było sprawdzać okiem, są teraz warunkami przebiegu:

- **dokładne wymiary** — każdy JPEG jest po zapisie mierzony na podstawie własnego nagłówka i
  przebieg przerywa się przy jakiejkolwiek różnicy,
- **brak paska przewijania** — pasek zabrałby szerokość i przesunął układ, więc jest wyłączony na
  poziomie przeglądarki i CSS,
- **brak kursora i stanów `:hover`** — kliknięcia idą przez procedury strony, nie przez mysz,
- **pełne kolory** — animacje i przejścia są wyłączone, więc nic nie zostaje sfotografowane w
  połowie rozjaśniania,
- **czysty kadr** — przed każdym ujęciem strona ładuje się od zera, a okno dialogowe pozostawione
  otwarte przez poprzedni kadr przerywa przebieg. Modal to natywny `<dialog>` podnoszony przez
  `showModal()`, więc o tym, że jest na wierzchu, mówi `[open]`; menu to nadal zwykły element
  chowany przez `hidden`. Skrypt pyta o jedno i drugie tak samo jak sam dashboard,
- **stały zegar** — „teraz” jest zamrożone na dacie odniesienia, więc zakresy analityki i znacznik
  ostatniej synchronizacji zawsze pokazują 14 sierpnia 2026, a nie dzień uruchomienia.

### Zawartość pakietu

Pięć rekomendowanych kadrów sklepowych to `01`, `02`, `05`, `08`, `09`. Pozostałe to warianty
dodatkowe.

| Nr | `pl` | `en` |
| --- | --- | --- |
| 01 | lista spotkań | lista spotkań |
| 02 | oś obecności w spotkaniu | oś obecności w spotkaniu |
| 03 | edycja i scalanie osoby | edycja i scalanie osoby |
| 04 | lista cykli | lista cykli |
| 05 | macierz frekwencji cyklu | macierz frekwencji cyklu |
| 06 | historia osoby w cyklu | historia osoby w cyklu |
| 07 | zestawienie osób | zestawienie osób |
| 08 | historia spotkań osoby | historia spotkań osoby |
| 09 | analityka i wykresy | analityka i wykresy |
| 10 | dane wykresu w tabeli | dane wykresu w tabeli |
| 11 | ustawienia rozszerzenia | ustawienia rozszerzenia |
| 12 | integracja z Google Sheets | integracja z Google Sheets |
| 13 | popup rozszerzenia | popup rozszerzenia |
| 14 | spotkanie poza cyklem | spotkanie poza cyklem |

Materiały promocyjne w obu folderach:

- `small-promo-440x280.jpg` — mały obraz promocji 440 × 280,
- `marquee-promo-1400x560.jpg` — transparent promocyjny 1400 × 560.

### Podgląd demonstracji w przeglądarce

Aby obejrzeć lub poprawić kadr ręcznie, uruchom sam serwer:

```bash
npm run serve
```

Następnie otwórz:

- `http://127.0.0.1:4177/dashboard/dashboard.html#meetings`
- `http://127.0.0.1:4177/dashboard/dashboard.html#groups`
- `http://127.0.0.1:4177/dashboard/dashboard.html#people`
- `http://127.0.0.1:4177/dashboard/dashboard.html#analytics`
- `http://127.0.0.1:4177/dashboard/dashboard.html#settings`
- `http://127.0.0.1:4177/tools/popup-showcase.html`
- `http://127.0.0.1:4177/tools/promo-small.html`
- `http://127.0.0.1:4177/tools/promo-marquee.html`

Aby otworzyć wersję angielską, dodaj `?lang=en` przed fragmentem `#`, na przykład:

- `http://127.0.0.1:4177/dashboard/dashboard.html?lang=en#meetings`
- `http://127.0.0.1:4177/dashboard/dashboard.html?lang=en#meeting=demo-consult`
- `http://127.0.0.1:4177/tools/popup-showcase.html?lang=en`

## Kod

| Plik | Rola |
| --- | --- |
| `package-extension.mjs` | paczka do sklepu: dobór plików, manifest bez `key`, kontrole, zapis ZIP |
| `capture.mjs` | cały przebieg zrzutów: serwer, przeglądarka, kadry, pomiar wymiarów |
| `demo-data.mjs` | dane demonstracyjne, obsada obu języków i lista kadrów |
| `demo-chrome.mjs` | atrapa API Chrome (magazyn, tożsamość, karty) |
| `demo-sheets.mjs` | atrapa API Google Sheets — arkusz zasilony tymi samymi rekordami, więc synchronizacja nie ma nic do przeniesienia i żadne zapytanie nie wychodzi do Google |
| `demo-clock.mjs` | zamrożony zegar demonstracji |
| `demo-server.mjs` | serwer plików repozytorium z podmianą modułu wejściowego stron |

ZIP jest zapisywany własnym kodem, a nie przez zewnętrzny program. Powód jest praktyczny:
`Compress-Archive` z Windows PowerShell 5.1 rozdziela ścieżki odwrotnym ukośnikiem, czego
specyfikacja ZIP nie dopuszcza i czego Chrome nie odczyta, a Info-ZIP nie jest na Windows dostępny
domyślnie.

Testy narzędzi: `npm run test:tools`.
