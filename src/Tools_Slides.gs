/**
 * @fileoverview slides toolset：一次建整份簡報（可套範本）/ 讀取 / 加頁 / 改頁 / 搬頁 / 刪頁（D）/ 取代文字。用 SlidesApp。
 *
 * deck spec 一次收完整（上限 40 頁）是為了閃過 6 分鐘限制：模型只需一次工具呼叫。
 * slide 類型與對應版面：
 *   title       → TITLE（title / subtitle）
 *   section     → SECTION_HEADER（title / subtitle）
 *   content     → TITLE_AND_BODY（title / body）；帶 image 時改用 TITLE_AND_TWO_COLUMNS，左文右圖
 *   two_column  → TITLE_AND_TWO_COLUMNS（title / left / right）
 *   quote       → SECTION_HEADER（quote 放大字、attribution 放副標）
 *   image       → TITLE_ONLY + 圖片置中（title / image / caption）
 *   image_full  → BLANK 滿版圖 + 底部半透明色帶標題（image / title）
 *   table       → TITLE_ONLY + 表格（title / rows 二維陣列，第一列表頭粗體）
 *   closing     → TITLE（title / subtitle）
 * body / left / right 可為字串或項目陣列；項目以「> 」開頭代表第二層。每頁可帶 notes（講者備忘）。
 * image 可為 Drive file id、Drive 網址或公開的 http(s) 圖片網址。
 *
 * 範本：slides_create_deck 的 template_id（或 Config slides_template_id）指定一份 Google Slides，會先 makeCopy 再清空頁面、
 * 用它的主題 / 母片 / 版面填內容，簡報就會長得像 owner 自己做的。
 */

const SLIDE_TYPES = Object.freeze(['title', 'section', 'content', 'two_column', 'quote', 'image', 'image_full', 'table', 'closing']);
const DECK_MAX_SLIDES = 40;
const SLIDES_READ_MAX_CHARS = 50000;
const SLIDES_READ_DEFAULT_CHARS = 20000;
const SLIDES_TABLE_MAX_CELLS = 120;
/** 第二層項目的前綴。 */
const SLIDE_SUBITEM_PREFIX = '> ';

/** @return {!Array<ToolDecl>} */
function slidesTools_() {
  const presId = { type: 'string', description: '簡報的 id' };
  const slideIndex = { type: 'integer', description: '頁碼，從 1 起算（slides_read 回的 index）' };
  const textOrList = (desc) => ({ type: ['string', 'array'], items: { type: 'string' }, description: desc + `；陣列 = 項目符號，項目以「${SLIDE_SUBITEM_PREFIX}」開頭為第二層` });
  const slideSpec = {
    type: 'object',
    description: '單頁規格',
    properties: {
      type: { type: 'string', enum: SLIDE_TYPES.slice() },
      title: { type: 'string' },
      subtitle: { type: 'string', description: 'title / section / closing 用' },
      body: textOrList('content 用：段落字串或項目陣列（建議 ≤ 5 點、每點 ≤ 15 字）'),
      left: textOrList('two_column 左欄'),
      right: textOrList('two_column 右欄'),
      quote: { type: 'string', description: 'quote 用' },
      attribution: { type: 'string', description: 'quote 的出處' },
      image: { type: 'string', description: 'image / image_full 必填，content 選填（左文右圖）：Drive 檔案 id / 網址，或公開的 http(s) 圖片網址' },
      caption: { type: 'string', description: 'image 的圖說（選填）' },
      rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: `table 用：二維字串陣列，第一列為表頭；上限 ${SLIDES_TABLE_MAX_CELLS} 格` },
      notes: { type: 'string', description: '講者備忘（建議每頁都寫：這頁要講什麼、怎麼銜接下一頁）' },
    },
    required: ['type'],
    additionalProperties: false,
  };
  return [
    {
      name: 'slides_create_deck', toolset: 'slides', risk: 'W',
      description: `一次建立整份 Google 簡報：給檔名與每頁規格（type 為 ${SLIDE_TYPES.join(' / ')}，上限 ${DECK_MAX_SLIDES} 頁）。先規劃好章節再呼叫：每頁一個重點、交錯使用 section / quote / two_column / image / table 避免整份都是條列、每頁寫 notes。template_id（或 owner 在 Config 設的預設範本）會複製該簡報的主題與版面。回傳 id 與網址。`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '簡報檔名' },
          slides: { type: 'array', items: slideSpec, description: '每頁規格，依序' },
          template_id: { type: 'string', description: '範本簡報的 id（選填；省略用 Config slides_template_id，再沒有就用預設主題）' },
          folder_id: { type: 'string', description: '目標資料夾 id（選填）' },
        },
        required: ['title', 'slides'], additionalProperties: false,
      },
      handler: slidesCreateDeck_,
    },
    {
      name: 'slides_read', toolset: 'slides', risk: 'R',
      description: '讀取簡報每一頁的文字（含版面名稱、圖片數、講者備忘），回的 index 可給 update / move / delete / replace_text 用。',
      parameters: {
        type: 'object',
        properties: { presentation_id: presId, max_chars: { type: 'integer', description: `預設 ${SLIDES_READ_DEFAULT_CHARS}，上限 ${SLIDES_READ_MAX_CHARS}` } },
        required: ['presentation_id'], additionalProperties: false,
      },
      handler: slidesRead_,
    },
    {
      name: 'slides_add_slide', toolset: 'slides', risk: 'W',
      description: '在既有簡報加一頁（規格同 slides_create_deck 的單頁）。給 position 插在該頁碼之前；省略加在最後。',
      parameters: {
        type: 'object',
        properties: { presentation_id: presId, slide: slideSpec, position: { type: 'integer', description: '插入位置（1 起算；省略 = 末端）' } },
        required: ['presentation_id', 'slide'], additionalProperties: false,
      },
      handler: slidesAddSlide_,
    },
    {
      name: 'slides_update_slide', toolset: 'slides', risk: 'W',
      description: '整頁重寫：以新規格在同一位置重建第 slide_index 頁（舊頁刪除）。要改一頁的內容、版面或圖時用這個；先用 slides_read 看現況。',
      parameters: {
        type: 'object',
        properties: { presentation_id: presId, slide_index: slideIndex, slide: slideSpec },
        required: ['presentation_id', 'slide_index', 'slide'], additionalProperties: false,
      },
      handler: slidesUpdateSlide_,
    },
    {
      name: 'slides_move_slide', toolset: 'slides', risk: 'W',
      description: '把第 from_index 頁搬到第 to_index 頁的位置（都從 1 起算）。',
      parameters: {
        type: 'object',
        properties: { presentation_id: presId, from_index: slideIndex, to_index: slideIndex },
        required: ['presentation_id', 'from_index', 'to_index'], additionalProperties: false,
      },
      handler: slidesMoveSlide_,
    },
    {
      name: 'slides_delete_slide', toolset: 'slides', risk: 'D',
      description: '刪除第 slide_index 頁（刪除動作：owner 需開啟 slides 的 delete 權限）。要改內容請用 slides_update_slide，不要刪了再加。',
      parameters: {
        type: 'object',
        properties: { presentation_id: presId, slide_index: slideIndex },
        required: ['presentation_id', 'slide_index'], additionalProperties: false,
      },
      handler: slidesDeleteSlide_,
    },
    {
      name: 'slides_replace_text', toolset: 'slides', risk: 'W',
      description: '把簡報中所有 find 文字換成 replace_with（逐字比對），回傳取代次數。給 slide_index 只改那一頁。',
      parameters: {
        type: 'object',
        properties: {
          presentation_id: presId, find: { type: 'string' }, replace_with: { type: 'string' },
          match_case: { type: 'boolean', description: '預設 true' }, slide_index: { type: 'integer', description: '只在這一頁取代（選填）' },
        },
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
 * @return {!Object} 正規化後的 spec（陣列欄位保證為陣列或字串）
 * @throws {Error}
 */
function validateSlideSpec_(spec, index) {
  const where = `第 ${index + 1} 頁`;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${where} 必須是 object。`);
  if (SLIDE_TYPES.indexOf(spec.type) === -1) throw new Error(`${where} type 必須是 ${SLIDE_TYPES.join(' / ')}，實際 ${spec.type}`);
  const out = { type: spec.type };
  ['title', 'subtitle', 'quote', 'attribution', 'notes', 'image', 'caption'].forEach((k) => {
    if (spec[k] !== undefined && spec[k] !== null && String(spec[k]).trim() !== '') out[k] = String(spec[k]).trim();
  });
  ['body', 'left', 'right'].forEach((k) => {
    if (spec[k] === undefined || spec[k] === null) return;
    out[k] = Array.isArray(spec[k]) ? spec[k].map((x) => String(x)) : String(spec[k]);
  });
  if (spec.type === 'quote' && !out.quote && !out.title) throw new Error(`${where}（quote）需要 quote 文字。`);
  if ((spec.type === 'image' || spec.type === 'image_full') && !out.image) throw new Error(`${where}（${spec.type}）需要 image（Drive id / 網址或圖片網址）。`);
  if (spec.type === 'table') {
    const rows = spec.rows;
    if (!Array.isArray(rows) || !rows.length || !rows.every(Array.isArray)) throw new Error(`${where}（table）需要 rows：非空的二維字串陣列。`);
    const cols = Math.max(...rows.map((r) => r.length));
    if (!cols) throw new Error(`${where}（table）rows 的每一列至少要一格。`);
    if (rows.length * cols > SLIDES_TABLE_MAX_CELLS) throw new Error(`${where}（table）太大（${rows.length}×${cols}），上限 ${SLIDES_TABLE_MAX_CELLS} 格；請拆頁或精簡。`);
    out.rows = rows.map((r) => { const row = r.map((c) => (c === null || c === undefined ? '' : String(c))); while (row.length < cols) row.push(''); return row; });
  }
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

/**
 * 項目陣列 → {text, levels}：去掉「> 」前綴並記每行層級。純函式。
 * @param {!Array<string>} items
 * @return {{lines: !Array<string>, levels: !Array<number>}}
 */
function splitBulletLevels_(items) {
  const lines = [];
  const levels = [];
  items.forEach((raw) => {
    let s = String(raw).replace(/^\s+/, '');
    let level = 0;
    while (s.indexOf(SLIDE_SUBITEM_PREFIX) === 0 || s.indexOf('>') === 0) {
      s = s.replace(/^>\s*/, '');
      level = Math.min(level + 1, 2);
    }
    if (!s.trim()) return;
    lines.push(s.trim());
    levels.push(level);
  });
  return { lines, levels };
}

// ---- 版面與圖片 -------------------------------------------------------------------------------

/**
 * spec.type → 版面。有範本時先找同名的預設版面，找不到退回 BLANK。
 * @param {GoogleAppsScript.Slides.Presentation} presentation
 * @param {!Object} spec
 * @return {*} PredefinedLayout 或 Layout
 */
function slideLayoutFor_(presentation, spec) {
  const L = SlidesApp.PredefinedLayout;
  const wanted = {
    title: L.TITLE, section: L.SECTION_HEADER, content: spec.image ? L.TITLE_AND_TWO_COLUMNS : L.TITLE_AND_BODY, two_column: L.TITLE_AND_TWO_COLUMNS,
    quote: L.SECTION_HEADER, image: L.TITLE_ONLY, image_full: L.BLANK, table: L.TITLE_ONLY, closing: L.TITLE,
  }[spec.type];
  // 範本的母片未必有每一種預設版面；用名稱比對，沒有就 BLANK。
  const names = { title: 'TITLE', section: 'SECTION_HEADER', content: spec.image ? 'TITLE_AND_TWO_COLUMNS' : 'TITLE_AND_BODY', two_column: 'TITLE_AND_TWO_COLUMNS', quote: 'SECTION_HEADER', image: 'TITLE_ONLY', image_full: 'BLANK', table: 'TITLE_ONLY', closing: 'TITLE' };
  try {
    const layouts = presentation.getLayouts();
    const hit = layouts.find((l) => String(l.getLayoutName()).toUpperCase() === names[spec.type]);
    if (hit) return hit;
    if (layouts.length) {
      const blank = layouts.find((l) => String(l.getLayoutName()).toUpperCase() === 'BLANK');
      const fallback = { TITLE_AND_TWO_COLUMNS: 'TITLE_AND_BODY', SECTION_HEADER: 'TITLE', TITLE_ONLY: 'TITLE_AND_BODY' }[names[spec.type]];
      const second = fallback ? layouts.find((l) => String(l.getLayoutName()).toUpperCase() === fallback) : null;
      return second || blank || wanted;
    }
  } catch (err) { /* 用預設 */ }
  return wanted;
}

/**
 * image 參數 → Blob 或公開網址。
 * @param {string} image Drive id / Drive 網址 / http(s) 圖片網址
 * @return {{blob: ?GoogleAppsScript.Base.Blob, url: string}}
 */
function slideImageSource_(image) {
  const s = String(image || '').trim();
  if (/^https?:\/\//i.test(s) && !/drive\.google\.com|docs\.google\.com/i.test(s)) return { blob: null, url: s };
  const id = parseDriveId_(s);
  try {
    return { blob: DriveApp.getFileById(id).getBlob(), url: '' };
  } catch (err) {
    throw new Error(`找不到圖片 ${s}：請給 Drive 檔案 id / 網址（drive_search 可查）或公開的 http(s) 圖片網址。`);
  }
}

/**
 * 在指定框內等比置入圖片（置中）。
 * @param {GoogleAppsScript.Slides.Slide} slide
 * @param {string} image
 * @param {{left: number, top: number, width: number, height: number}} box 單位 pt
 * @return {GoogleAppsScript.Slides.Image}
 */
function placeImage_(slide, image, box) {
  const src = slideImageSource_(image);
  const img = src.blob ? slide.insertImage(src.blob) : slide.insertImage(src.url);
  const w = img.getWidth();
  const h = img.getHeight();
  const scale = Math.min(box.width / w, box.height / h);
  const nw = w * scale;
  const nh = h * scale;
  img.setWidth(nw).setHeight(nh).setLeft(box.left + (box.width - nw) / 2).setTop(box.top + (box.height - nh) / 2);
  return img;
}

/**
 * 依規格建一頁（可指定插入位置）。
 * @param {GoogleAppsScript.Slides.Presentation} presentation
 * @param {!Object} spec validateSlideSpec_ 的輸出
 * @param {number=} insertAt 0-based 插入位置；省略 = 末端
 * @return {GoogleAppsScript.Slides.Slide}
 */
function addSlideFromSpec_(presentation, spec, insertAt) {
  const layout = slideLayoutFor_(presentation, spec);
  const slide = insertAt === undefined || insertAt === null ? presentation.appendSlide(layout) : presentation.insertSlide(insertAt, layout);
  const pageW = presentation.getPageWidth();
  const pageH = presentation.getPageHeight();

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
      const split = splitBulletLevels_(value);
      if (!split.lines.length) return false;
      text.setText(split.lines.join('\n'));
      try { text.getListStyle().applyListPreset(SlidesApp.ListPreset.DISC_CIRCLE_SQUARE); } catch (err) { /* 版面不支援項目符號就算了 */ }
      if (split.levels.some((lv) => lv > 0)) {
        try {
          const paras = text.getParagraphs();
          paras.forEach((p, i) => {
            const lv = split.levels[i] || 0;
            if (!lv) return;
            const style = p.getRange().getParagraphStyle();
            style.setIndentStart(36 + 36 * lv).setIndentFirstLine(18 + 36 * lv);
          });
        } catch (err) { /* 縮排失敗不影響內容 */ }
      }
    } else {
      text.setText(String(value));
    }
    return true;
  };

  const used = [];
  const box = (left, top, width, height) => ({ left, top, width, height });
  if (spec.type === 'quote') {
    used.push(fill(titles[0], spec.quote ? `「${spec.quote}」` : spec.title) && titles[0]);
    used.push(fill(subtitles[0] || bodies[0], spec.attribution ? `— ${spec.attribution}` : '') && (subtitles[0] || bodies[0]));
  } else if (spec.type === 'image_full') {
    placeImage_(slide, spec.image, box(0, 0, pageW, pageH));
    if (spec.title) {
      const bandH = Math.min(80, pageH * 0.18);
      const band = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, 0, pageH - bandH, pageW, bandH);
      band.getFill().setSolidFill('#000000', 0.55);
      band.getBorder().setTransparent();
      const t = band.getText();
      t.setText(spec.title);
      t.getTextStyle().setForegroundColor('#FFFFFF').setFontSize(Math.round(bandH * 0.35)).setBold(true);
      band.setContentAlignment(SlidesApp.ContentAlignment.MIDDLE);
      t.getParagraphStyle().setIndentStart(24);
    }
  } else {
    used.push(fill(titles[0], spec.title) && titles[0]);
    if (spec.type === 'two_column') {
      used.push(fill(bodies[0], spec.left) && bodies[0]);
      used.push(fill(bodies[1], spec.right) && bodies[1]);
    } else if (spec.type === 'content') {
      used.push(fill(bodies[0], spec.body) && bodies[0]);
      if (spec.image) {
        // 右欄 placeholder 的位置給圖；沒有第二欄就放右半邊。
        const right = bodies[1];
        const area = right ? box(right.getLeft(), right.getTop(), right.getWidth(), right.getHeight()) : box(pageW * 0.52, pageH * 0.25, pageW * 0.43, pageH * 0.6);
        placeImage_(slide, spec.image, area);
      }
    } else if (spec.type === 'image') {
      const titleH = titles[0] ? titles[0].getTop() + titles[0].getHeight() : pageH * 0.18;
      const captionH = spec.caption ? 30 : 0;
      const margin = 24;
      placeImage_(slide, spec.image, box(margin, titleH + 8, pageW - margin * 2, pageH - titleH - 8 - captionH - margin));
      if (spec.caption) {
        const cap = slide.insertTextBox(spec.caption, margin, pageH - captionH - margin + 4, pageW - margin * 2, captionH);
        cap.getText().getTextStyle().setFontSize(11).setItalic(true);
        cap.getText().getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER);
      }
    } else if (spec.type === 'table') {
      const rows = spec.rows;
      const titleH = titles[0] ? titles[0].getTop() + titles[0].getHeight() : pageH * 0.18;
      const margin = 24;
      const table = slide.insertTable(rows.length, rows[0].length, margin, titleH + 12, pageW - margin * 2, Math.min(pageH - titleH - 12 - margin, 28 * rows.length));
      rows.forEach((r, ri) => r.forEach((c, ci) => {
        const cell = table.getCell(ri, ci);
        cell.getText().setText(c);
        if (ri === 0) cell.getText().getTextStyle().setBold(true);
      }));
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
 * 每頁文字（shape / table 文字 + 版面 + 圖片數 + 講者備忘）。
 * @param {GoogleAppsScript.Slides.Presentation} presentation
 * @return {!Array<{index: number, layout: string, images: number, texts: !Array<string>, notes: string}>}
 */
function slidesToText_(presentation) {
  return presentation.getSlides().map((slide, i) => {
    const texts = [];
    let images = 0;
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
      } else if (type === SlidesApp.PageElementType.IMAGE) {
        images++;
      }
    });
    let notes = '';
    try { notes = slide.getNotesPage().getSpeakerNotesShape().getText().asString().trim(); } catch (err) { notes = ''; }
    let layout = '';
    try { layout = slide.getLayout() ? String(slide.getLayout().getLayoutName()) : ''; } catch (err) { layout = ''; }
    return { index: i + 1, layout, images, texts, notes };
  });
}

/**
 * @param {GoogleAppsScript.Slides.Presentation} p
 * @return {!Object}
 */
function presInfo_(p) {
  return { id: p.getId(), title: p.getName(), url: p.getUrl(), slide_count: p.getSlides().length };
}

/**
 * 第 n 頁（1 起算）。
 * @param {GoogleAppsScript.Slides.Presentation} presentation
 * @param {*} index
 * @param {string} field
 * @return {{slide: GoogleAppsScript.Slides.Slide, i: number}}
 * @throws {Error}
 */
function slideAt_(presentation, index, field) {
  const slides = presentation.getSlides();
  const n = Math.floor(toNumber_(index, 0));
  if (n < 1 || n > slides.length) throw new Error(`參數 ${field} 必須在 1 到 ${slides.length} 之間（這份簡報有 ${slides.length} 頁），實際 ${index}。`);
  return { slide: slides[n - 1], i: n - 1 };
}

// ---- handlers ------------------------------------------------------------------------

function slidesCreateDeck_(args, ctx) {
  const title = requireString_(args.title, 'title');
  const specs = validateDeckSpec_(args.slides);
  const templateId = parseDriveId_(args.template_id || (ctx && ctx.config && ctx.config.slidesTemplateId) || '');
  let presentation;
  let fromTemplate = false;
  if (templateId) {
    let copy;
    try { copy = DriveApp.getFileById(templateId).makeCopy(title); } catch (err) { throw new Error(`無法複製範本簡報 ${templateId}：${err && err.message || err}`); }
    presentation = SlidesApp.openById(copy.getId());
    fromTemplate = true;
  } else {
    presentation = SlidesApp.create(title);
  }
  const initial = presentation.getSlides();
  specs.forEach((spec) => addSlideFromSpec_(presentation, spec));
  initial.forEach((s) => s.remove());
  presentation.saveAndClose();
  if (args.folder_id) DriveApp.getFileById(presentation.getId()).moveTo(requireFolder_(args.folder_id));
  return Object.assign(presInfo_(SlidesApp.openById(presentation.getId())), { from_template: fromTemplate ? templateId : '' });
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
  const count = presentation.getSlides().length;
  const spec = validateSlideSpec_(args.slide, count);
  let at;
  if (args.position !== undefined && args.position !== null && args.position !== '') {
    const n = Math.floor(toNumber_(args.position, 0));
    if (n < 1 || n > count + 1) throw new Error(`position 必須在 1 到 ${count + 1} 之間。`);
    at = n - 1;
  }
  addSlideFromSpec_(presentation, spec, at);
  presentation.saveAndClose();
  return Object.assign(presInfo_(SlidesApp.openById(presentation.getId())), { added: spec.type, position: at === undefined ? count + 1 : at + 1 });
}

function slidesUpdateSlide_(args) {
  const presentation = SlidesApp.openById(requireString_(args.presentation_id, 'presentation_id'));
  const target = slideAt_(presentation, args.slide_index, 'slide_index');
  const spec = validateSlideSpec_(args.slide, target.i);
  addSlideFromSpec_(presentation, spec, target.i);
  target.slide.remove();
  presentation.saveAndClose();
  return Object.assign(presInfo_(SlidesApp.openById(presentation.getId())), { updated: target.i + 1, type: spec.type });
}

function slidesMoveSlide_(args) {
  const presentation = SlidesApp.openById(requireString_(args.presentation_id, 'presentation_id'));
  const from = slideAt_(presentation, args.from_index, 'from_index');
  const to = slideAt_(presentation, args.to_index, 'to_index');
  if (from.i !== to.i) from.slide.move(to.i > from.i ? to.i + 1 : to.i);
  presentation.saveAndClose();
  return Object.assign(presInfo_(SlidesApp.openById(presentation.getId())), { moved: from.i + 1, to: to.i + 1 });
}

function slidesDeleteSlide_(args) {
  const presentation = SlidesApp.openById(requireString_(args.presentation_id, 'presentation_id'));
  if (presentation.getSlides().length <= 1) throw new Error('簡報只剩一頁，不能刪；請用 slides_update_slide 改內容。');
  const target = slideAt_(presentation, args.slide_index, 'slide_index');
  const preview = slidesToText_(presentation)[target.i].texts.join(' / ').slice(0, 120);
  target.slide.remove();
  presentation.saveAndClose();
  return Object.assign(presInfo_(SlidesApp.openById(presentation.getId())), { deleted: target.i + 1, was: preview });
}

function slidesReplaceText_(args) {
  const presentation = SlidesApp.openById(requireString_(args.presentation_id, 'presentation_id'));
  const find = requireString_(args.find, 'find');
  const matchCase = args.match_case !== false;
  let count;
  if (args.slide_index !== undefined && args.slide_index !== null && args.slide_index !== '') {
    count = slideAt_(presentation, args.slide_index, 'slide_index').slide.replaceAllText(find, String(args.replace_with), matchCase);
  } else {
    count = presentation.replaceAllText(find, String(args.replace_with), matchCase);
  }
  presentation.saveAndClose();
  return Object.assign(presInfo_(presentation), { replaced: count, slide_index: args.slide_index || null });
}
