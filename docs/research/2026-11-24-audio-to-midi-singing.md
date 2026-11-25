# Ресерч: перегон пения в ноты (audio → MIDI) для вокального тренажёра

Дата: 2026-11-24. Контекст: [`docs/features/2026-11-24-vocal-trainer.md`](../features/2026-11-24-vocal-trainer.md),
шаг 2 «Перегон» и открытый вопрос про украшения (решение 6).
Задача: одноголосная запись педагога (свободный темп, без метронома) → ноты
`PartNote {midi, start, end}` в секундах; оценка ученика только по высоте
(±15/±7/±2 ¢, октава важна). Код не менялся, это только ресерч.

Пометка **[не проверено]** — утверждение, которое я не смог подтвердить
первоисточником. Все числа точности взяты из статей и таблиц, названных рядом;
на наших голосах ничего не мерили.

## Короткий вывод

**Первый выбор — SwiftF0 в браузере + сегментация нот по штрафу за смену
ноты (changepoint DP) или наш Mauch-HMM поверх его контура.** SwiftF0 — это
ONNX-модель на 135 КБ под MIT. Её автор уже держит открытое браузерное демо на
нашем же стеке (Vue 3 + Vite + TS, ONNX Runtime Web в воркере, `notes.ts` на
TS). На чужих вокальных данных она заметно лучше pYIN: pitch F1 0.847 против
0.653 на Vocadito, а голос/пауза почти не теряются. Это бьёт ровно туда, где,
судя по коду, ломается наш перегон: ошибки голос/пауза у pYIN и жадный
сегментатор с полосой ±60 ¢, в которую вибрато не влезает.

**Запасной вариант и потолок качества — GAME (openvpi, преемник SOME).** Из
найденного это единственная открытая модель, обученная именно на пении: даёт
границы нот и дробную высоту ноты, экспортируется в ONNX. Но её **веса под
CC BY-NC-SA 4.0**, то есть в коммерческом продукте их нельзя использовать без
разрешения авторов. Годится для внутреннего сравнения и разметки; в прод —
только после договорённости с openvpi или обучения своей модели (код MIT,
данные нужны свои). Basic Pitch TS лицензионно чист (Apache-2.0) и готов для
браузера, но на пении он слабее специализированных моделей. Пакет не обновлялся
с 2022 года, а его pitch bend идёт с шагом в треть полутона.

**Главная оговорка:** ни для одного варианта нет опубликованных note-level
чисел на материале вроде нашего (соло-голос с микрофона, русский язык, вибрато
и мелизмы). Бенчмарк, где SwiftF0 первый, сделал сам автор SwiftF0. Решать
надо замером на 20–30 живых записях педагогов (см. «Что проверить»).

## Почему сейчас плохо — гипотезы по коду (не проверены на записях)

Что делает `transcribe` ([`src/training/vocal/part.ts`](../../src/training/vocal/part.ts)):
`analyzeOffline` с `f0: { tracker: 'pyin' }`, затем `segmentTake(timeline)`
с методом по умолчанию `greedy`, затем `note.note` — целый MIDI.

1. **f0 и голос/пауза от pYIN.** Наш `PyinTracker`
   ([`pyin.ts`](../../src/audio-core/core/dsp/pyin.ts)) — онлайн-вариант
   с Viterbi на фиксированном лаге 5 кадров. Офлайн-перегон гоняет тот же
   живой анализ, а не полный Viterbi по всей записи. Внешние замеры (на
   librosa-pYIN, не на нашей реализации) показывают, что слабое место pYIN —
   голос/пауза и октавы. На вокале MIR-1K: RPA 74.7 против 95.7 у CREPE и
   97.3 у RMVPE ([RMVPE, Table 3](https://arxiv.org/html/2306.15412)).
   В бенчмарке: OA 77.9 против 96.8 у SwiftF0
   ([SwiftF0, Table 2](https://arxiv.org/html/2508.18440)).
2. **Жадный сегментатор**
   ([`notes.ts`](../../src/audio-core/core/segmentation/notes.ts)) держит ноту
   в полосе `toleranceCents = 60` вокруг бегущего центра. Вибрато певца ±50–100 ¢
   из этой полосы выходит и может порезать ноту на куски. Мелизм при этом
   держится на `minNoteMs = 80`.
3. **Ноты вне «фраз» теряются.** `segmentPhrases` режет запись по порогу
   громкости, а `attachPhrases` выбрасывает ноты вне фраз. Тихие концы и
   начала нот пропадают.
4. **`transcribe` выбрасывает то, что уже посчитано:** `slides`, дробную
   `midi` и `cents` у `NoteSegment`
   ([`types.ts`](../../src/audio-core/core/segmentation/types.ts)).

## Сравнение

Колонка «пение» — лучшее найденное число именно на пении, со ссылкой. Метрики
разных статей между собой напрямую не сравнимы.

| Подход | Ноты? | Точность на пении | Вибрато / слайды / мелизмы | Где работает | Размер / скорость | Лицензия (код / веса) |
|---|---|---|---|---|---|---|
| **SwiftF0** + `segment_notes` | f0 + свой сегментатор (DP), дробная высота ноты | f0: Vocadito F1 0.847 (pYIN 0.653) [bench](https://github.com/lars76/pitch-benchmark/blob/main/BENCHMARK.md); ноты: **не мерено** | вибрато внутри ноты (штраф за отклонение обрезан на 2 полутонах); слайды и мелизмы <~80 мс сливаются **[проверить]** | браузер (ORT Web, демо есть), офлайн и стрим (176 мс lookahead) | 135 КБ ONNX, ~180× реального времени на ядро | MIT / MIT (веса в репо) |
| **GAME** (openvpi, 2026) | да: границы + дробная высота | свои метрики: overall acc 0.95, pitch RMSE 0.55–0.68 полутона на своём валид-сете [ALGORITHMS.md](https://github.com/openvpi/GAME/blob/main/ALGORITHMS.md); COnPOff не публикует | одна высота на ноту; глайды не поддерживает; слитные слоги (`note_slur`) — только в режиме выравнивания | сервер (PyTorch / ORT); браузер **[не проверено]** | small ~12M (ONNX zip 45.7 МБ), medium ~50M, large ~100M | MIT / **CC BY-NC-SA 4.0** |
| **SOME** (openvpi) | да, дробная высота | чисел нет | не описано | сервер, CPU в 9× быстрее реального времени (i5-12400) | ckpt ~435 МБ (zip) | MIT / **CC BY-NC-SA 4.0**; заменён GAME |
| **ROSVOT** (ACL'24) | да, целый MIDI | COnPOff 77.4 (чистый, свой сет) / 47.4 на MIR-ST500 вне домена [arXiv 2405.09940](https://arxiv.org/html/2405.09940v2) | без особой обработки | сервер (PyTorch + CUDA) | — | MIT / веса обучены на M4Singer (**CC BY-NC-SA**) |
| **Basic Pitch** (+TS) | да, целый MIDI + pitch bends | Molina: Fno 52.3, F 34.6 (VOCANO 64.2 / 51.3) [arXiv 2203.09893, Table 3](https://arxiv.org/abs/2203.09893) | бенды по кадрам с шагом **1/3 полутона**; ноты короче ~120 мс выкидываются | браузер (tfjs 3.x) | 16 782 параметра, веса 742 КБ | Apache-2.0 / Apache-2.0 |
| **Tony / pYIN notes** (наш `mauch.ts`) | да, HMM по целым MIDI | COn 67.5, COnPOff 43.9 (чистый сет ROSVOT, Table 1) | вибрато внутри ноты, пока укладывается в σ | что угодно (наш TS) | — | Tony GPL; наша реализация своя |
| **CREPE** / torchcrepe | только f0 | MIR-1K vocals RPA 95.7 (RMVPE, Table 3); Vocadito F1 0.781 | всё остаётся в кривой f0 | браузер (tfjs-демо), сервер | ~22M (full); 0.4× реального времени на CPU | MIT / MIT |
| **RMVPE** | только f0 | MIR-1K vocals RPA 97.3; Vocadito F1 0.862 | в кривой f0 | сервер; ONNX экспортируется | — | Apache-2.0 (Dream-High) / форк yxlllc без лицензии |
| **FCPE** | f0 + неневральный перевод в MIDI | Vocadito F1 0.786 | в кривой f0 | сервер (PyTorch) | 28× реального времени | MIT / явно не указана |
| **PESTO** | только f0 | Vocadito F1 0.759 | в кривой f0 | сервер; ONNX, стрим <10 мс | ~130k параметров | **LGPL-3.0** |
| **SPICE** | только f0 | Vocadito F1 0.734 | в кривой f0 | TF Hub | — | **[не проверено]** |
| VOCANO, MusicYOLO, Omnizart, EffNet/CTC (MIR-ST500), T3MS, VocalParse | да | см. ниже | — | сервер / GPU | — | см. ниже |
| Klangio API, Melodyne | Klangio — да; Melodyne — нет API | — | — | облако / DAW | — | коммерческие |

Строки «Vocadito F1» — из одного бенчмарка
([pitch-benchmark v2.1, «Performance by dataset»](https://github.com/lars76/pitch-benchmark/blob/main/BENCHMARK.md)).
Это pitch F1 при допуске 50 ¢, усреднённый по 8 искажённым условиям (шум,
реверберация, фильтр микрофона); чистое аудио в среднее не входит. pYIN там —
`librosa.pyin`
([algorithms/pyin.py](https://github.com/lars76/pitch-benchmark/blob/main/algorithms/pyin.py)).

## По кандидатам

### Специализированные модели для пения (note-level)

**GAME — Generative Adaptive MIDI Extractor** ([repo](https://github.com/openvpi/GAME)).
README называет его «the upgraded successor of SOME». Устройство: энкодер по
мел-спектру с шагом 10 мс; сегментатор предсказывает границы нот дискретной
диффузией (D3PM, K шагов — баланс качества и скорости); оценщик выдаёт одну
высоту на отрезок, 257 бинов на MIDI 0–128 с центроидом, то есть **дробный
MIDI** ([ALGORITHMS.md](https://github.com/openvpi/GAME/blob/main/ALGORITHMS.md)).
Заявлена устойчивость к шуму, реверберации и аккомпанементу; при обучении
аугментировали DEMAND, MUSAN, MUSDB18-HQ и RIR.

- Метрики свои (ACD, QER, presence F1, pitch RMSE, overall accuracy), COnPOff
  нет. На чистом валиде overall accuracy ≈0.95, pitch RMSE 0.55–0.68 полутона
  (ALGORITHMS.md). Валид-сет взят от тех же певцов, что и обучение, так что
  на чужие голоса цифры переносить нельзя.
- Обучение: ~32 ч приватной разметки на en/ja/yue/zh. Русского нет; авторы
  пишут, что модели «should work well on other languages»
  ([release v1.0.0](https://github.com/openvpi/GAME/releases/tag/v1.0.0)).
- Украшения: «the model does not support glide types» (README, `note_glide`
  удаляется из вывода). Вибрато не обсуждается. Раз высота одна на отрезок,
  вибрато остаётся в одной ноте, если сегментатор не поставит внутрь границу
  — это мой вывод **[проверить]**.
- Деплой: экспорт в ONNX (opset 17), готовые ONNX в
  [v1.0.3](https://github.com/openvpi/GAME/releases/tag/v1.0.3) (опубликован
  2026-03-09): small 45.7 МБ, medium 180 МБ, large 362 МБ (размеры zip по
  GitHub API). Пайплайн ONNX-инференса в репо не дают, только описание
  ([ONNX.md](https://github.com/openvpi/GAME/blob/main/ONNX.md)): подмодели
  `encoder` / `segmenter` / `estimator` + `dur2bd` / `bd2dur`; вход — волна
  44.1 кГц; выход — `durations`, `presence`, `scores` (MIDI float). Запуск в
  ONNX Runtime Web **не проверен**: неизвестно, поддержаны ли все операторы,
  и 45 МБ на клиенте — заметная загрузка.
- Лицензия: код MIT, **веса — «The model files apply CC BY-NC-SA 4.0
  license»** (release v1.0.0).

**SOME** ([repo](https://github.com/openvpi/SOME)) — предшественник GAME,
README отсылает к GAME. Дробная высота нот (для разметки DiffSinger); 9×
реального времени на i5-12400 CPU и 300× на 3080Ti. Веса тоже CC BY-NC-SA 4.0
([releases](https://github.com/openvpi/SOME/releases)). Смысла брать вместо
GAME нет.

**ROSVOT** ([repo](https://github.com/RickyL-2000/ROSVOT), [ACL'24, arXiv 2405.09940](https://arxiv.org/abs/2405.09940)).
Многомасштабная сегментация плюс attention-декодер высоты; на входе f0 от
RMVPE. Выход — **целый MIDI** (120 классов, «each pitch number is the exact
MIDI number»). Цифры из [HTML-версии статьи](https://arxiv.org/html/2405.09940v2):

- Table 1, чистый / шумный: COn 94.0 / 93.8, COnPOff 77.4 / 77.0. Там же
  TONY: 67.5 / 49.2 и 43.9 / 28.4; VOCANO: 75.8 и 50.2; MusicYOLO: 82.2 и 58.9.
- Table 6, вне домена: MIR-ST500 — COn / COnP / COnPOff 72.1 / 65.9 / 47.4;
  у Gu et al. 2023 там же 78.1 / 70.0 / 52.8.
- Вибрато авторы упоминают только как трудность («vibrato and appoggiatura
  further complicate boundary localization»). Мелизм поддержан условием на
  границы слов.

Веса — zip на Google Drive, «trained with M4Singer only». Датасет M4Singer
под CC BY-NC-SA 4.0 («NonCommercial!»,
[dataset_license.md](https://github.com/M4Singer/M4Singer/blob/master/dataset_license.md)),
значит у весов как минимум неясный коммерческий статус. Нужны Python и CUDA.
Для нас хуже GAME: целые ноты, нет ONNX, обучена на мандаринском поп-пении.

**VOCANO** ([repo](https://github.com/B05901022/VOCANO), ISMIR 2021). Patch-CNN
даёт f0, затем PyramidNet сегментирует ноты. Код MIT, лицензия весов не
указана, последний пуш в 2021 году. Влит в Omnizart. На Molina: Fno 64.2,
F 51.3 ([Basic Pitch, Table 3](https://arxiv.org/abs/2203.09893)). Пик памяти
8.5 ГБ (там же).

**MusicYOLO** ([repo](https://github.com/xk-wang/MusicYOLO), ICASSP 2022).
Ноты ищутся как объекты на спектрограмме детектором YOLOX. Сделан под
сольфеджио — по материалу это ближе всего к нам. Apache-2.0; веса на
BaiduYun с кодом доступа; PyTorch 1.8 и CUDA 10.2. COnPOff 58.9 на чистом
сете ROSVOT (Table 1); на ST500 «MusicYOLO-I» 0.586
([T3MS, Table VII](https://arxiv.org/html/2502.12438)).

**Omnizart** ([repo](https://github.com/Music-and-Culture-Technology-Lab/omnizart)).
MIT, Python/TF, модули `vocal` (ноты) и `vocal-contour` (f0). Не работает на
ARM-маках (README). Ориентирован на вокал в миксе — для нас лишний.

**MIR-ST500 / EfficientNet-b0 и CTC+CE** (Wang & Jang:
[ICASSP 2021](https://github.com/york135/singing_transcription_ICASSP2021),
[TASLP 2022](https://github.com/york135/CTC_CE_for_AST)). Поп-вокал с
аккомпанементом, веса в репо или на Drive, **лицензия не указана**. По
[T3MS, Table VII](https://arxiv.org/html/2502.12438) у CE+CTC на ST500:
COnPOff 0.574.

**Новее (2025–2026):**

- **T3MS** ([arXiv 2502.12438](https://arxiv.org/abs/2502.12438), TASLP):
  SOTA на ST500 — COn / COnP / COnPOff 0.806 / 0.771 / 0.610 (Table VII).
  Предсказывает и длительности в долях такта. Ссылки на код не нашёл.
- **VocalParse** ([arXiv 2605.04613](https://arxiv.org/abs/2605.04613),
  [repo](https://github.com/pymaster17/VocalParse), Apache-2.0 код): LLM на
  базе Qwen3-ASR-1.7B. Выдаёт текст, ноты в токенах и BPM, а длительность
  считает как доли × 60/BPM. Абсолютных onset/offset в README нет. Для
  свободного темпа и браузера не подходит.
- Yamamoto, SSL-фронтенды для пения
  ([APSIPA 2023, arXiv 2306.12714](https://arxiv.org/abs/2306.12714)) — чисел
  на странице аннотации нет, глубже не смотрел.

Вывод по разделу: на открытых данных специализированные модели дают
COnPOff ≈0.5–0.6 на поп-вокале (ST500) и до ≈0.77 на чистом «своём» домене.
Tony-подобный HMM в тех же таблицах заметно хуже (COnPOff 43.9 на чистом
сете ROSVOT). Коммерчески чистых весов для пения среди найденного нет.

### Универсальная транскрипция: Basic Pitch

[Python](https://github.com/spotify/basic-pitch) и
[TypeScript](https://github.com/spotify/basic-pitch-ts),
[ICASSP 2022, arXiv 2203.09893](https://arxiv.org/abs/2203.09893).

- Модель: 16 782 параметра, CQT с шагом ≈11 мс. Три выхода: onset, note и
  contour с 3 бинами на полутон. Ноты собираются постобработкой, ноты короче
  ≈120 мс выбрасываются (статья, §3).
- Пение: на Molina — Fno 52.3, F 34.6, Acc 62.6 против VOCANO 64.2 / 51.3 /
  61.6 (Table 3). Вокальная часть обучения — iKala, а ноты для неё
  «automatically generated using pyin-notes», то есть разметка в стиле Tony
  (§4). В pitch-benchmark на Vocadito F1 0.638; <10 ¢ только 24.8% кадров,
  потому что там берётся нотный выход с разрешением в полутон.
- Украшения: `addPitchBendsToNoteEvents` добавляет `pitchBends` по кадрам в
  бинах контура, 3 бина на полутон, то есть шаг ≈33 ¢
  ([toMidi.ts](https://github.com/spotify/basic-pitch-ts/blob/main/src/toMidi.ts)).
  Для допусков ±7/±2 ¢ этого мало. Нота — целый MIDI, `pitchMidi = index + 21`.
- Браузер: npm [`@spotify/basic-pitch`](https://registry.npmjs.org/@spotify/basic-pitch)
  1.0.1 от 2022-08-05, зависимость `@tensorflow/tfjs ^3.2.0`. Последний коммит
  в репо — 2023-01-10 (GitHub API). Вход 22 050 Гц, окна по 2 с. Веса
  `group1-shard1of1.bin` весят 742 392 байта. Модель полифоническая — на
  одном голосе возможны лишние параллельные ноты **[проверить]**.
- Лицензия: Apache-2.0, веса лежат в репо.

### f0-трекеры (ноты из них делает отдельный сегментатор)

**SwiftF0** ([repo](https://github.com/lars76/swift-f0),
[arXiv 2508.18440](https://arxiv.org/abs/2508.18440),
[статья «как устроено»](https://swift-f0.github.io/how/)).

- Модель: на вход волна 16 кГц, на выход pitch и confidence каждые 16 мс
  (hop 256). STFT считается внутри графа. Диапазон 46.875–2093.75 Гц. По
  README — 14 386 параметров, `model.onnx` весит 135 090 байт. Статья
  описывает v0.1 с 95 842 параметрами; в демо `MODEL_VERSION = '0.3.0'`.
- Точность: в собственном бенчмарке автора
  ([pitch-benchmark v2.1](https://github.com/lars76/pitch-benchmark)) первое
  место — F1 0.781, статистически вничью с RMVPE (0.768); pYIN 0.653 → 0.506
  в общем зачёте. По точности высоты (BENCHMARK.md, «Pitch accuracy») <10 ¢
  у SwiftF0 67.7% кадров, у RMVPE 68.5%, у pYIN 52.2%; октавные ошибки вверх
  и вниз 0.34% и 0.42%. **Оговорка:** бенчмарк ведёт автор SwiftF0, а
  датасет под CC BY-NC-SA.
- Ноты: `segment_notes` — это «standard penalized changepoint problem»
  (Killick et al. 2012), решается динамическим программированием. У ноты одна
  дробная высота μ (одна из измеренных; функция стоимости L1 с весом
  confidence, то есть фактически взвешенная медиана). Стоимость кадра:
  off-pitch (обрезана на 2 полутонах, чтобы одиночная октавная ошибка не резала
  ноту) + unvoiced (логит confidence) + quiet (провал громкости). Штраф за
  ноту β = `pitch_hold_ms` / 16 мс, по умолчанию 80 мс. Новая высота на
  полутон в стороне становится нотой, если держится дольше 80 мс; при
  возврате к старой — 160 мс (статья, раздел 5 «Notes»). Значит, вибрато
  остаётся в ноте, а быстрые мелизмы (<80 мс на ноту) сольются — это главное,
  что надо проверить. Слайды в статье не разбираются.
- Браузер: демо-сайт
  ([swift-f0.github.io](https://github.com/swift-f0/swift-f0.github.io), MIT)
  собран на Vue 3 + Vite + TS. В нём `ONNXService.ts`, `onnx-worker.js`
  (ORT Web wasm, `numThreads = 1`, длинные записи режутся на окна с
  контекстом 11/10 кадров) и **`notes.ts` — TS-порт `segment_notes`**. Это
  почти готовый к переносу код.
- Лицензия: MIT для кода и весов.

**RMVPE** ([Interspeech 2023, arXiv 2306.15412](https://arxiv.org/abs/2306.15412)).
Сделан под вокал в миксе. Table 1, MIR-ST500 (полифония): RPA 89.3 против
CREPE 81.6 и pYIN 63.9. Table 3, вокал MIR-1K: 97.3 / 95.7 / 74.7. Код
[Dream-High/RMVPE](https://github.com/Dream-High/RMVPE) под Apache-2.0;
популярный форк [yxlllc/RMVPE](https://github.com/yxlllc/RMVPE) лицензии не
указывает. ONNX экспортируется, но с фиксированным hop. Для чистого соло-голоса
SwiftF0 почти не уступает (Vocadito 0.847 против 0.862) и в 13 раз быстрее.

**CREPE / torchcrepe** ([CREPE](https://github.com/marl/crepe), MIT, ICASSP 2018;
[torchcrepe](https://github.com/maxrmorrison/torchcrepe), MIT, Viterbi-декодер
и periodicity). 360 бинов по 20 ¢. Есть tfjs-демо в браузере
([marl.github.io/crepe](https://marl.github.io/crepe/)). В pitch-benchmark
0.4× реального времени на одном ядре; в статье SwiftF0 CREPE оценён в ~22M
параметров. Только f0.

**FCPE** ([repo](https://github.com/CNChTu/FCPE), MIT,
[arXiv 2509.15140](https://arxiv.org/abs/2509.15140)). f0 плюс перевод в MIDI
«quantized from f0 using non neural network methods». Чисел в README нет;
Vocadito F1 0.786 по бенчмарку. Отдельной лицензии на веса нет **[не проверено]**.

**PESTO** ([repo](https://github.com/SonyCSLParis/pesto),
[TISMIR 2025, arXiv 2508.01488](https://arxiv.org/abs/2508.01488)).
Самообучаемая модель на ~130k параметров, стриминг <10 мс, ONNX. Код под
**LGPL-3.0**. На Vocadito 0.759, <10 ¢ только 38.3%. Нам не лучше SwiftF0.

**SPICE** ([arXiv 1910.11664](https://arxiv.org/abs/1910.11664),
[TF Hub tutorial](https://www.tensorflow.org/hub/tutorials/spice)). Только
pitch + uncertainty, 16 кГц. В туториале ноты собираются эвристикой с
квантованием под темп. Vocadito 0.734. Лицензию модели не проверил.

### Tony / pYIN note HMM

Наш `method: 'mauch'`
([`mauch.ts`](../../src/audio-core/core/segmentation/mauch.ts)) повторяет
подход Tony (Mauch et al. 2015): HMM по тишине и целым MIDI с гауссовым
наблюдением σ = 0.55 полутона, слайдов не выдаёт. Препринт статьи Tony
([code.soundsoftware.ac.uk](https://code.soundsoftware.ac.uk/attachments/download/1423/tony-paper_preprint.pdf))
не открылся (connection refused), поэтому её собственные числа
**не проверены**. Независимое сравнение есть у ROSVOT: TONY COn 67.5,
COnPOff 43.9 на чистом сете, 49.2 / 28.4 на шумном (Table 1). Сам Tony как
приложение ([проект](https://code.soundsoftware.ac.uk/projects/tony/)) хорош
как **инструмент ручной разметки эталона** для наших замеров.

### Коммерческие API

- **Klangio API** ([klang.io/api](https://klang.io/api/)): на выходе MIDI,
  MusicXML, PDF, GP5; «with the instruments and transcription modes of the
  Klangio apps». Цен на странице нет — тарифы в
  [дашборде](https://api-dashboard.klang.io/), который без входа пуст.
  Поддержку вокала (Sing2Notes) в API и цену **не проверил**.
- **Melodyne**: публичного web/cloud API не нашёл. У Celemony есть ARA — это
  интерфейс плагин↔DAW, а не сервис распознавания
  ([celemony.com](https://www.celemony.com/en/service1/about-celemony/technologies)).
- Другие «audio → MIDI API» в поиске были только перепродажами неясного
  происхождения — не включал.

### «snow tec melisma»

**Опознать не удалось.** Искал «"snow tec" melisma», «snowtec melisma
vocal», «"SnowTec" OR "Snow Tec" singing/vocal/music» и про канал «Snow» с
мелизмами. Нашлись только лыжная мазь, типы снега, певцы по имени Snow
(Singing Carrots) и общие статьи о мелизмах. Ни техники, ни инструмента, ни
статьи, ни канала с таким названием не нашёл. Нужно уточнить у автора
референса (ссылку или контекст).

## Украшения: как их нести в партии

- **Ни одна найденная нотная модель не выдаёт слайды и вибрато как
  отдельную разметку.** GAME глайды прямо не поддерживает. ROSVOT, VOCANO и
  Tony дают целые ноты. Basic Pitch даёт бенды с шагом ≈33 ¢. Значит,
  украшения придётся брать **из кривой f0 поверх нот** — и это лучше делать
  у себя.
- Формат хранения предлагаю такой: `PartNote` остаётся целью оценки, а
  истиной об украшениях служит **кривая f0 педагога** (`Contour.midi`, уже
  считается в `transcribe`; можно пересчитать из сохранённого аудио или
  сохранить прорежённой в центах). Из кривой выводятся:
  - вибрато на ноте — частота в Гц и размах в ¢ по кривой без тренда; нота
    остаётся одной, центр — медиана;
  - слайд — отрезок между нотами со сдвигом высоты (тип `Slide` уже есть в
    [`types.ts`](../../src/audio-core/core/segmentation/types.ts));
  - мелизм — последовательность коротких нот на одном слоге. В модели это
    просто ноты; нужен только флаг «связано» (как `note_slur` у GAME), если
    разбор будет судить их иначе.
- MIDI нужен только на экспорт: кривая → Pitch Bend по кадрам, диапазон бенда
  задаётся RPN 0. Для отдельных изгибов на каждую ноту есть MPE — каждая нота
  на своём канале ([MIDI Association, MPE](https://midi.org/mpe-midi-polyphonic-expression)).
  Конкретные умолчания диапазона по спецификации **не проверял**.
- Для уровня ±2 ¢ покадровое сравнение бессмысленно: даже у лучших трекеров
  <10 ¢ попадают лишь ~68% кадров (pitch-benchmark, «Pitch accuracy»). Это
  подтверждает мысль концепции: мерить по устойчивой части ноты (медиана,
  взвешенная по confidence) — так же, как SwiftF0 выбирает μ ноты.

## Набросок интеграции (первый выбор: SwiftF0)

Всё на клиенте, офлайн после записи, в Web Worker. Заодно уходит проблема
«перегон в основном потоке» из концепции.

1. **Зависимость:** `onnxruntime-web` (зафиксировать версию) либо, как в демо,
   его wasm-сборка `ort.wasm.min.mjs`, подключённая через `?url` в Vite.
   `numThreads = 1`, как в демо: многопоточность wasm требует cross-origin
   isolation — общее ограничение SharedArrayBuffer, по докам ORT не проверял.
2. **Новый модуль** `src/audio-core/ml/swiftf0/` (или рядом с
   `core/dsp`): `model.onnx` с файлом лицензии MIT; `swiftf0.worker.ts` —
   загрузка сессии и инференс окнами по образцу
   [`onnx-worker.js`](https://github.com/swift-f0/swift-f0.github.io/blob/main/src/onnx-worker.js);
   `swiftf0.ts` — клиент `detect(samples16k) → {pitchHz, confidence, loudnessDb, frameRate: 62.5}`.
   Ресемплинг в 16 кГц — через `OfflineAudioContext` до отправки в воркер.
3. **Сегментация** — две ветки в `segmentTake`
   ([`segmentation/index.ts`](../../src/audio-core/core/segmentation/index.ts)),
   чтобы сравнить замером:
   - `method: 'changepoint'` — порт
     [`notes.ts`](https://github.com/swift-f0/swift-f0.github.io/blob/main/src/notes.ts)
     (~100 строк, MIT, с атрибуцией) в
     `src/audio-core/core/segmentation/changepoint.ts`;
   - существующий `mauch` и `greedy` по контуру SwiftF0. Для этого кадры
     пишутся в `Timeline` в колонки `midi`, `f0Confidence`, `dbfs` при
     62.5 fps. Нужно проверить, что `Timeline` и `segmentPhrases` не
     завязаны на 100 fps.
4. **`transcribe`** ([`part.ts`](../../src/training/vocal/part.ts))
   становится `async` и получает параметр `tracker: 'swiftf0' | 'pyin'`
   (pYIN оставить для A/B). Перевод `Note{start, end, pitch_hz}` →
   `PartNote{midi: round(69 + 12·log2(f/440)), start, end}`. Стоит добавить
   необязательное `cents` — фактический центр педагога; тогда в
   [`vocalStore.ts`](../../src/lib/vocalStore.ts) поднять `PART_VERSION`.
   `Contour` строится из того же выхода. В
   [`RecordView.vue`](../../src/views/vocal/RecordView.vue) — `await` и
   прогресс.
5. **Ученик:** живой контур и дальше можно рисовать pYIN, но разбор
   ([`review.ts`](../../src/training/vocal/review.ts)) лучше считать по
   SwiftF0, прогнав его офлайн по записи попытки. Тогда педагога и ученика
   меряет один трекер, и систематический сдвиг в центах не исказит ±2/±7.
   Вариант — стрим SwiftF0 с lookahead 176 мс (README).

**Если GAME (при решённой лицензии):** сервис на Python + `onnxruntime` CPU.
Он берёт запись из бакета `vocal-recordings`, пишет `part` в
`vocal_trainings` и возвращает ноты с дробным MIDI (`scores`) и
`durations`. Edge Function Supabase для этого, вероятно, не подойдёт — нужен
отдельный контейнер **[не проверено]**. Стоимость: GAME-small ~12M
параметров, ориентир — SOME в 9× быстрее реального времени на десктопном
CPU, то есть хватит дешёвого CPU-инстанса без GPU (оценка, не замер).
Браузерный вариант — ORT Web с 45 МБ модели — проверить на поддержку
операторов.

## Открытые вопросы и что проверить на живых голосах

1. **Эталон.** Собрать 20–30 записей педагогов: разные голоса и регистры,
   прямой звук, вибрато, слайды, быстрые мелизмы, тихие окончания. Разметить
   ноты вручную в Tony.
2. **Метрики.** COn / COnP / COnPOff по критериям MIREX (как в
   [Basic Pitch §4](https://arxiv.org/abs/2203.09893): высота ±50 ¢, onset
   ±50 мс, offset ±20% длительности) плюс ошибка центра ноты в ¢ относительно
   эталона — для уровней ±7/±2.
3. **Кандидаты в прогоне:** текущие `greedy` и `mauch` на pYIN; SwiftF0 +
   `changepoint` / `mauch` / `greedy`; Basic Pitch TS; GAME-small (только
   внутренне, лицензия NC).
4. **Мелизмы против вибрато:** при каком `pitch_hold_ms` быстрые ноты
   отделяются, а вибрато ещё не режется? Возможно, нужен отдельный детектор
   вибрато (периодичность 4–8 Гц в кривой) до сегментации — **гипотеза**.
5. **Слайды:** SwiftF0 и GAME их не моделируют. Проверить, во что они
   превращаются (короткие ноты-ступеньки?), и держать ли постпроход
   «ступенька → `Slide`» из нашего `notes.ts`.
6. **Лицензия GAME:** продукт коммерческий? Если да — написать openvpi про
   коммерческую лицензию весов или закладывать свою разметку и обучение
   (~32 ч разметки у них).
7. **«snow tec melisma»** — уточнить у автора, что имелось в виду.
8. **Производительность в браузере:** время SwiftF0 на 1–3-минутной записи на
   слабом телефоне. Демо меряет `msPerSecond`; по README ~180× реального
   времени на десктопное ядро.
