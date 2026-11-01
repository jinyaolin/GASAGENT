/**
 * @fileoverview slides toolset：一次建整份簡報 / 讀取 / 加一頁 / 取代文字。用 SlidesApp。
 *
 * deck spec 一次收完整（上限 40 頁）是為了閃過 6 分鐘限制：模型只需一次工具呼叫。
 * slide 類型與對應版面：
 *   title      → TITLE（title / subtitle）
 *   section    → SECTION_HEADER（title / subtitle）
 *   content    → TITLE_AND_BODY（title / body：字串或項目陣列）
 *   two_column → TITLE_AND_TWO_COLUMNS（title / left / right：各為字串或項目陣列）
 *   quote      → SECTION_HEADER（quote 放大字、attribution 放副標）
 *   closing    → TITLE（title / subtitle）
 * 每頁可帶 notes（講者備忘）。
 */

const SLIDE_TYPES = Object.freeze(['title', 'section', 'content', 'two_column', 'quote', 'closing']);
const DECK_MAX_SLIDES = 40;
const SLIDES_READ_MAX_CHARS = 50000;
const SLIDES_READ_DEFAULT_CHARS = 20000;

/** @return {!Array<ToolDecl>} */
function slidesTools_() {
  const presId = { type: 'string', description: '簡報的 id' };
  const textOrList = (desc) => ({ type: ['string', 'array'], items: { type: 'string' }, description: desc });
  const slideSpec = {
    type: 'object',
    description: '單頁規格',
    properties: {
      type: { type: 'string', enum: SLIDE_TYPES.slice() },
      title: { type: 'string' },
      subtitle: { type: 'string', description: 'title / section / closing 用' },
      body: textOrList('content 用：段落字串或項目陣列'),
      left: textOrList('two_column 左欄'),
      right: textOrList('two_column 右欄'),
      quote: { type: 'string', description: 'quote 用' },
      attribution: { type: 'string', description: 'quote 的出處' },
      notes: { type: 'string', description: '講者備忘（選填）' },
    },
    required: ['type'],
    additionalProperties: false,
  };
  return [
    {
      name: 'slides_create_deck', toolset: 'slides', risk: 'W',
      description: `一次建立整份 Google 簡報：給標題與每頁規格（type 為 ${SLIDE_TYPES.join(' / ')}，上限 ${DECK_MAX_SLIDES} 頁）。回傳 id 與網址。`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '簡報檔名' },
          slides: { type: 'array', items: slideSpec, description: '每頁規格，依序' },
          folder_id: { type: 'string', description: '目標資料夾 id（選填）' },
        },
        required: ['title', 'slides'], additionalProperties: false,
      },
      handler: slidesCreateDeck_,
    },
    {
      name: 'slides_read', toolset: 'slides', risk: 'R',
      description: '讀取簡報每一頁的文字（含講者備忘）。',
      parameters: {
        type: 'object',
        properties: { presentation_id: presId, max_chars: { type: 'integer', description: `預設 ${SLIDES_READ_DEFAULT_CHARS}，上限 ${SLIDES_READ_MAX_CHARS}` } },
        required: ['presentation_id'], additionalProperties: false,
      },
      handler: slidesRead_,
    },
    {
      name: 'slides_add_slide', toolset: 'slides', risk: 'W',
      description: '在既有簡報末端加一頁（規格同 slides_create_deck 的單頁）。',
      parameters: {
        type: 'object',
        properties: { presentation_id: presId, slide: slideSpec },
        required: ['presentation_id', 'slide'], additionalProperties: false,
      },
      handler: slidesAddSlide_,
    },
    {
      name: 'slides_replace_text', toolset: 'slides', risk: 'W',
      description: '把簡報中所有 find 文字換成 replace_with（逐字比對），回傳取代次數。',
      parameters: {
        type: 'object',
        properties: { presentation_id: presId, find: { type: 'string' }, replace_with: { type: 'string' }, match_case: { type: 'boolean', description: '預設 true' } },
        required: ['presentation_id', 'find', 'replace_with'], additionalProperties: false,
      },
      handler: slidesReplaceText_,
    },
  ];
}

// ---- spec 驗證（純函式）-------------------------------------------------------------------

/**
 * @param {*} spec 單頁
 * @param {number} index 0-based（錯誤訊息用）
 * @return {!Object} 正規化後的 spec（陣列欄位保證為陣列或 undefined）
 * @throws {Error}
 */
function validateSlideSpec_(spec, index) {
  const where = `第 ${index + 1} 頁`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${where} 必須是 object。`);
  if (SLIDE_TYPES.indexOf(spec.type) === -1) throw new Error(`${where} type 必須是 ${SLIDE_TYPES.join(' / ')}，實際 ${spec.type}`);
  const out = { type: spec.type };
  ['title', 'subtitle', 'quote', 'attribution', 'notes'].forEach((k) => {
    if (spec[k] !== undefined && spec[k] !== null) out[k] = String(spec[k]);
  });
  ['body', 'left', 'right'].forEach((k) => {
    if (spec[k] === undefined || spec[k] === null) return;
    out[k] = Array.isArray(spec[k]) ? spec[k].map(String) : String(spec[k]);
  });
  if (spec.type === 'quote' && !out.quote && !out.title) throw new Error(`${where}（quote）需要 quote 文字。`);
  return out;
}

/**
 * @param {*} slides
 * @return {!Array<!Object>}
 * @throws {Error}
 */
function validateDeckSpec_(slides) {
  if (!Array.isArray(slides) || !slides.length) throw new Error('slides 必須是非空陣列。');
  if (slides.length > DECK_MAX_SLIDES) throw new Error(`一份簡報最多 ${DECK_MAX_SLIDES} 頁（目前 ${slides.length}）。`);
  return slides.map(validateSlideSpec_);
}

// ---- 版面填入 -----------------------------------------------------------------------------

/**
 * @param {GoogleAppsScript.Slides.Presentation} presentation
 * @param {!Object} spec validateSlideSpec_ 的輸出
 * @return {GoogleAppsScript.Slides.Slide}
 */
function addSlideFromSpec_(presentation, spec) {
  const L = SlidesApp.PredefinedLayout;
  const layout = { title: L.TITLE, section: L.SECTION_HEADER, content: L.TITLE_AND_BODY, two_column: L.TITLE_AND_TWO_COLUMNS, quote: L.SECTION_HEADER, closing: L.TITLE }[spec.type];
  const slide = presentation.appendSlide(layout);

  const P = SlidesApp.PlaceholderType;
  const titles = [];
  const subtitles = [];
  const bodies = [];
  // getPlaceholders() 回 PageElement，要 asShape() 才有 getPlaceholderType / getText；只轉一次，之後用同一批物件比對。
  const shapes = slide.getPlaceholders().map((pe) => pe.asShape());
  shapes.forEach((shape) => {
    const t = shape.getPlaceholderType();
    if (t === P.TITLE || t === P.CENTERED_TITLE) titles.push(shape);
    else if (t === P.SUBTITLE) subtitles.push(shape);
    else if (t === P.BODY) bodies.push(shape);
  });
  bodies.sort((a, b) => a.getLeft() - b.getLeft());

  const fill = (shape, value) => {
    if (!shape) return false;
    if (value === undefined || value === null || (Array.isArray(value) ? !value.length : !String(value))) return false;
    const text = shape.getText();
    if (Array.isArray(value)) {
      text.setText(value.join('\n'));
      try { text.getListStyle().applyListPreset(SlidesApp.ListPreset.DISC_CIRCLE_SQUARE); } catch (err) { /* 版面不支援項目符號就算了 */ }
    } else {
      text.setText(String(value));
    }
    return true;
  };

  const used = [];
  if (spec.type === 'quote') {
    used.push(fill(titles[0], spec.quote ? `「${spec.quote}」` : spec.title) && titles[0]);
    used.push(fill(subtitles[0] || bodies[0], spec.attribution ? `— ${spec.attribution}` : '') && (subtitles[0] || bodies[0]));
  } else {
    used.push(fill(titles[0], spec.title) && titles[0]);
    if (spec.type === 'two_column') {
      used.push(fill(bodies[0], spec.left) && bodies[0]);
      used.push(fill(bodies[1], spec.right) && bodies[1]);
    } else if (spec.type === 'content') {
      used.push(fill(bodies[0], spec.body) && bodies[0]);
    } else {
      used.push(fill(subtitles[0] || bodies[0], spec.subtitle) && (subtitles[0] || bodies[0]));
    }
  }
  // 沒用到的 placeholder 刪掉，避免簡報上留「按一下即可新增文字」。
  shapes.forEach((shape) => { if (used.indexOf(shape) === -1) shape.remove(); });

  if (spec.notes) slide.getNotesPage().getSpeakerNotesShape().getText().setText(spec.notes);
  return slide;
}

/**
 * 每頁文字（shape / table 文字 + 講者備忘）。
 * @param {GoogleAppsScript.Slides.Presentation} presentation
 * @return {!Array<{index: number, texts: !Array<string>, notes: string}>}
 */
function slidesToText_(presentation) {
  return presentation.getSlides().map((slide, i) => {
    const texts = [];
    slide.getPageElements().forEach((pe) => {
      const type = pe.getPageElementType();
      if (type === SlidesApp.PageElementType.SHAPE) {
        const t = pe.asShape().getText().asString().trim();
        if (t) texts.push(t);
      } else if (type === SlidesApp.PageElementType.TABLE) {
        const table = pe.asTable();
        for (let r = 0; r < table.getNumRows(); r++) {
          const cells = [];
          for (let c = 0; c < table.getNumColumns(); c++) cells.push(table.getCell(r, c).getText().asString().trim());
          texts.push(cells.join('\t'));
        }
      }
    });
    let notes = '';
    try { notes = slide.getNotesPage().getSpeakerNotesShape().getText().asString().trim(); } catch (err) { notes = ''; }
    return { index: i + 1, texts, notes };
  });
}

/**
 * @param {GoogleAppsScript.Slides.Presentation} p
 * @return {!Object}
 */
function presInfo_(p) {
  return { id: p.getId(), title: p.getName(), url: p.getUrl(), slide_count: p.getSlides().length };
}

// ---- handlers ------------------------------------------------------------------------

function slidesCreateDeck_(args) {
  const title = requireString_(args.title, 'title');
  const specs = validateDeckSpec_(args.slides);
  const presentation = SlidesApp.create(title);
  const initial = presentation.getSlides();
  specs.forEach((spec) => addSlideFromSpec_(presentation, spec));
  initial.forEach((s) => s.remove());
  presentation.saveAndClose();
  if (args.folder_id) DriveApp.getFileById(presentation.getId()).moveTo(DriveApp.getFolderById(String(args.folder_id)));
  return presInfo_(SlidesApp.openById(presentation.getId()));
}

function slidesRead_(args) {
  const presentation = SlidesApp.openById(requireString_(args.presentation_id, 'presentation_id'));
  const max = clampInt_(args.max_chars, SLIDES_READ_DEFAULT_CHARS, 200, SLIDES_READ_MAX_CHARS);
  const slides = slidesToText_(presentation);
  let used = 0;
  const kept = [];
  let truncated = false;
  slides.some((s) => {
    const len = s.texts.join('\n').length + s.notes.length;
    if (used + len > max && kept.length) { truncated = true; return true; }
    used += len;
    kept.push(s);
    return false;
  });
  return Object.assign(presInfo_(presentation), { truncated, slides: kept });
}

function slidesAddSlide_(args) {
  const presentation = SlidesApp.openById(requireString_(args.presentation_id, 'presentation_id'));
  const spec = validateSlideSpec_(args.slide, presentation.getSlides().length);
  addSlideFromSpec_(presentation, spec);
  presentation.saveAndClose();
  return Object.assign(presInfo_(SlidesApp.openById(presentation.getId())), { added: spec.type });
}

function slidesReplaceText_(args) {
  const presentation = SlidesApp.openById(requireString_(args.presentation_id, 'presentation_id'));
  const find = requireString_(args.find, 'find');
  const count = presentation.replaceAllText(find, String(args.replace_with), args.match_case !== false);
  presentation.saveAndClose();
  return Object.assign(presInfo_(presentation), { replaced: count });
}
