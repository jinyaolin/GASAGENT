/**
 * @fileoverview calendar toolset：列事件 / 建事件 / 改事件。用 CalendarApp（預設日曆；可給 calendar_id）。
 * 建事件可加 guests，但 M2 不寄邀請（sendInvites=false），邀請屬外發行為留待日後以 X 類工具處理。
 */

const CALENDAR_MAX_EVENTS = 50;
const CALENDAR_DEFAULT_EVENTS = 25;
const CALENDAR_DESC_MAX = 400;

/** @return {!Array<ToolDecl>} */
function calendarTools_() {
  const calId = { type: 'string', description: '日曆 id（選填，預設主日曆）' };
  const when = (desc) => ({ type: 'string', description: desc + '，ISO 8601（例 2026-11-03T09:00:00+08:00）' });
  return [
    {
      name: 'calendar_list_events', toolset: 'calendar', risk: 'R',
      description: '列出時間範圍內的事件（省略 end 則為 start 起 7 天），可用 query 過濾標題 / 說明。',
      parameters: {
        type: 'object',
        properties: {
          start: when('起'),
          end: when('迄（選填）'),
          query: { type: 'string', description: '關鍵字（選填）' },
          calendar_id: calId,
          max_results: { type: 'integer', description: `預設 ${CALENDAR_DEFAULT_EVENTS}，上限 ${CALENDAR_MAX_EVENTS}` },
        },
        required: ['start'], additionalProperties: false,
      },
      handler: calendarListEvents_,
    },
    {
      name: 'calendar_create_event', toolset: 'calendar', risk: 'W',
      description: '建立事件。all_day=true 時 start / end 只取日期（end 為不含的隔日；省略 = 單日）。不會寄邀請給 guests。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          start: when('開始'),
          end: when('結束'),
          description: { type: 'string' },
          location: { type: 'string' },
          guests: { type: 'array', items: { type: 'string' }, description: '與會者 email（不寄邀請）' },
          all_day: { type: 'boolean', description: '預設 false' },
          calendar_id: calId,
        },
        required: ['title', 'start'], additionalProperties: false,
      },
      handler: calendarCreateEvent_,
    },
    {
      name: 'calendar_update_event', toolset: 'calendar', risk: 'W',
      description: '修改既有事件的標題 / 時間 / 說明 / 地點（只改有給的欄位）。',
      parameters: {
        type: 'object',
        properties: {
          event_id: { type: 'string', description: 'calendar_list_events 回傳的 event_id' },
          title: { type: 'string' },
          start: when('新開始'),
          end: when('新結束'),
          description: { type: 'string' },
          location: { type: 'string' },
          calendar_id: calId,
        },
        required: ['event_id'], additionalProperties: false,
      },
      handler: calendarUpdateEvent_,
    },
  ];
}

// ---- helpers ------------------------------------------------------------------------

/**
 * @param {*} id
 * @return {GoogleAppsScript.Calendar.Calendar}
 */
function resolveCalendar_(id) {
  if (!id) return CalendarApp.getDefaultCalendar();
  const cal = CalendarApp.getCalendarById(String(id));
  if (!cal) throw new Error(`找不到日曆 ${id}。`);
  return cal;
}

/**
 * @param {GoogleAppsScript.Calendar.CalendarEvent} ev
 * @return {!Object}
 */
function calendarEventInfo_(ev) {
  const desc = truncateText_(ev.getDescription(), CALENDAR_DESC_MAX);
  return {
    event_id: ev.getId(),
    title: ev.getTitle(),
    start: fmtDate_(ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime()),
    end: fmtDate_(ev.isAllDayEvent() ? ev.getAllDayEndDate() : ev.getEndTime()),
    all_day: ev.isAllDayEvent(),
    location: ev.getLocation(),
    description: desc.text,
    guests: ev.getGuestList().length,
    my_status: String(ev.getMyStatus() || ''),
  };
}

// ---- handlers ------------------------------------------------------------------------

function calendarListEvents_(args) {
  const cal = resolveCalendar_(args.calendar_id);
  const start = parseDateArg_(args.start, 'start');
  const end = args.end ? parseDateArg_(args.end, 'end') : new Date(start.getTime() + 7 * 86400000);
  if (end <= start) throw new Error('end 必須晚於 start。');
  const max = clampInt_(args.max_results, CALENDAR_DEFAULT_EVENTS, 1, CALENDAR_MAX_EVENTS);
  const opts = args.query ? { search: String(args.query) } : {};
  const events = cal.getEvents(start, end, opts);
  return {
    calendar: cal.getName(), start: fmtDate_(start), end: fmtDate_(end), count: events.length, truncated: events.length > max,
    events: events.slice(0, max).map(calendarEventInfo_),
  };
}

function calendarCreateEvent_(args) {
  const cal = resolveCalendar_(args.calendar_id);
  const title = requireString_(args.title, 'title');
  const start = parseDateArg_(args.start, 'start');
  const opts = {};
  if (args.description) opts.description = String(args.description);
  if (args.location) opts.location = String(args.location);
  const guests = toStringList_(args.guests);
  if (guests.length) { opts.guests = guests.join(','); opts.sendInvites = false; }
  let ev;
  if (args.all_day) {
    ev = args.end ? cal.createAllDayEvent(title, start, parseDateArg_(args.end, 'end'), opts) : cal.createAllDayEvent(title, start, opts);
  } else {
    if (!args.end) throw new Error('非全天事件需要 end。');
    const end = parseDateArg_(args.end, 'end');
    if (end <= start) throw new Error('end 必須晚於 start。');
    ev = cal.createEvent(title, start, end, opts);
  }
  return Object.assign({ calendar: cal.getName(), created: true }, calendarEventInfo_(ev));
}

function calendarUpdateEvent_(args) {
  const cal = resolveCalendar_(args.calendar_id);
  const ev = cal.getEventById(requireString_(args.event_id, 'event_id'));
  if (!ev) throw new Error(`找不到事件 ${args.event_id}。`);
  const changed = [];
  if (args.title) { ev.setTitle(String(args.title)); changed.push('title'); }
  if (args.description !== undefined) { ev.setDescription(String(args.description)); changed.push('description'); }
  if (args.location !== undefined) { ev.setLocation(String(args.location)); changed.push('location'); }
  if (args.start || args.end) {
    if (ev.isAllDayEvent()) {
      const s = args.start ? parseDateArg_(args.start, 'start') : ev.getAllDayStartDate();
      if (args.end) ev.setAllDayDates(s, parseDateArg_(args.end, 'end')); else ev.setAllDayDate(s);
    } else {
      const s = args.start ? parseDateArg_(args.start, 'start') : ev.getStartTime();
      const e = args.end ? parseDateArg_(args.end, 'end') : ev.getEndTime();
      if (e <= s) throw new Error('end 必須晚於 start。');
      ev.setTime(s, e);
    }
    changed.push('time');
  }
  return Object.assign({ calendar: cal.getName(), changed }, calendarEventInfo_(ev));
}
