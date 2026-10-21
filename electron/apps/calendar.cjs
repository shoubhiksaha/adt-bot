// Calendars (Google Calendar, Outlook) and files (Google Drive, OneDrive) for the bots.
const { addresses, text } = require("./common.cjs");

const GCAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GDRIVE = "https://www.googleapis.com/drive/v3/files";
const GUPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const GRAPH = "https://graph.microsoft.com/v1.0/me";

const iso = (value, label) => {
  const ms = Date.parse(text(value, 60));
  if (!Number.isFinite(ms)) throw new Error(`${label} isn't a date and time (use e.g. 2026-10-22T15:00:00+05:30).`);
  return new Date(ms).toISOString();
};

/** Google Docs, Sheets and Slides export as text; other files download as they are. */
const EXPORTS = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-yaml|csv))/;
const MAX_FILE = 15 * 1024 * 1024;

function createCalendar({ accounts }) {
  const account = (id, service) => {
    const a = accounts.get(id);
    if (!a) throw new Error("That account isn't connected any more.");
    if (!a.services?.includes(service)) throw new Error(`${a.label} isn't connected for ${service === "drive" ? "files" : service}. Connect it again with that ticked.`);
    return a;
  };

  async function events(params) {
    const a = account(params.account, "calendar");
    const from = params.from ? iso(params.from, "The start") : new Date().toISOString();
    const to = params.to ? iso(params.to, "The end") : new Date(Date.parse(from) + 7 * 86_400_000).toISOString();
    const query = text(params.query, 200);
    if (a.provider === "google") {
      const { data } = await accounts.api(a.id, "GET", GCAL, { query: { timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: 50, q: query } });
      return (data?.items ?? []).map((e) => ({
        id: e.id,
        title: e.summary ?? "(no title)",
        start: e.start?.dateTime ?? e.start?.date ?? "",
        end: e.end?.dateTime ?? e.end?.date ?? "",
        location: e.location ?? "",
        attendees: (e.attendees ?? []).map((x) => x.email),
        organizer: e.organizer?.email ?? "",
        link: e.htmlLink ?? "",
        description: text(e.description, 2000),
      }));
    }
    const { data } = await accounts.api(a.id, "GET", `${GRAPH}/calendarView`, {
      query: { startDateTime: from, endDateTime: to, $top: 50, $orderby: "start/dateTime", $select: "id,subject,start,end,location,attendees,organizer,webLink,bodyPreview" },
      headers: { prefer: 'outlook.timezone="UTC"' },
    });
    return (data?.value ?? [])
      .map((e) => ({
        id: e.id,
        title: e.subject ?? "(no title)",
        start: e.start?.dateTime ? `${e.start.dateTime.replace(/\.\d+$/, "")}Z` : "",
        end: e.end?.dateTime ? `${e.end.dateTime.replace(/\.\d+$/, "")}Z` : "",
        location: e.location?.displayName ?? "",
        attendees: (e.attendees ?? []).map((x) => x.emailAddress?.address).filter(Boolean),
        organizer: e.organizer?.emailAddress?.address ?? "",
        link: e.webLink ?? "",
        description: e.bodyPreview ?? "",
      }))
      .filter((e) => !query || `${e.title} ${e.description} ${e.location}`.toLowerCase().includes(query.toLowerCase()));
  }

  async function createEvent(params) {
    const a = account(params.account, "calendar");
    const title = text(params.title, 300).trim();
    if (!title) throw new Error("Give the event a title.");
    const start = iso(params.start, "The start");
    const end = params.end ? iso(params.end, "The end") : new Date(Date.parse(start) + 3600_000).toISOString();
    if (Date.parse(end) <= Date.parse(start)) throw new Error("The event must end after it starts.");
    const attendees = params.attendees ? addresses(params.attendees) : [];
    const location = text(params.location, 300);
    const description = text(params.description, 8000);
    if (a.provider === "google") {
      const { data } = await accounts.api(a.id, "POST", GCAL, {
        // Invitations go out only when asked for.
        query: { sendUpdates: params.notify ? "all" : "none" },
        json: { summary: title, start: { dateTime: start }, end: { dateTime: end }, location, description, attendees: attendees.map((email) => ({ email })) },
      });
      return { id: data.id, title, start, end, link: data.htmlLink ?? "" };
    }
    const { data } = await accounts.api(a.id, "POST", `${GRAPH}/events`, {
      json: {
        subject: title,
        start: { dateTime: start.replace(/Z$/, ""), timeZone: "UTC" },
        end: { dateTime: end.replace(/Z$/, ""), timeZone: "UTC" },
        location: { displayName: location },
        body: { contentType: "Text", content: description },
        attendees: attendees.map((address) => ({ emailAddress: { address }, type: "required" })),
      },
    });
    return { id: data.id, title, start, end, link: data.webLink ?? "" };
  }

  async function searchFiles(params) {
    const a = account(params.account, "drive");
    const query = text(params.query, 200).trim();
    const limit = Math.min(Math.max(Number(params.limit) || 15, 1), 50);
    if (a.provider === "google") {
      const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const q = query ? `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false` : "trashed = false";
      const { data } = await accounts.api(a.id, "GET", GDRIVE, { query: { q, pageSize: limit, fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)", ...(query ? {} : { orderBy: "modifiedTime desc" }) } });
      return (data?.files ?? []).map((f) => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, link: f.webViewLink ?? "", size: Number(f.size) || undefined }));
    }
    const url = query ? `${GRAPH}/drive/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')` : `${GRAPH}/drive/recent`;
    const { data } = await accounts.api(a.id, "GET", url, { query: { $top: limit, $select: "id,name,file,size,lastModifiedDateTime,webUrl" } });
    return (data?.value ?? []).map((f) => ({ id: f.id, name: f.name, type: f.file?.mimeType ?? "folder", modified: f.lastModifiedDateTime, link: f.webUrl ?? "", size: f.size }));
  }

  /** A file's text, or (PDFs, Word…) its bytes for the app to read. */
  async function readFile(params) {
    const a = account(params.account, "drive");
    const id = text(params.id, 300);
    if (a.provider === "google") {
      const { data: meta } = await accounts.api(a.id, "GET", `${GDRIVE}/${encodeURIComponent(id)}`, { query: { fields: "id,name,mimeType,size,webViewLink" } });
      const exportAs = EXPORTS[meta.mimeType];
      if (exportAs) {
        const { buffer } = await accounts.api(a.id, "GET", `${GDRIVE}/${encodeURIComponent(id)}/export`, { query: { mimeType: exportAs }, max: MAX_FILE });
        return { name: meta.name, type: meta.mimeType, link: meta.webViewLink, text: buffer.toString("utf8") };
      }
      if (meta.mimeType?.startsWith("application/vnd.google-apps")) throw new Error(`${meta.name} is a Google ${meta.mimeType.split(".").pop()}, which can't be read as text.`);
      const { buffer } = await accounts.api(a.id, "GET", `${GDRIVE}/${encodeURIComponent(id)}`, { query: { alt: "media" }, max: MAX_FILE });
      return TEXTUAL.test(meta.mimeType ?? "") ? { name: meta.name, type: meta.mimeType, link: meta.webViewLink, text: buffer.toString("utf8") } : { name: meta.name, type: meta.mimeType, link: meta.webViewLink, base64: buffer.toString("base64") };
    }
    const { data: meta } = await accounts.api(a.id, "GET", `${GRAPH}/drive/items/${encodeURIComponent(id)}`, { query: { $select: "id,name,file,size,webUrl" } });
    if (!meta.file) throw new Error(`${meta.name} is a folder.`);
    const { buffer } = await accounts.api(a.id, "GET", `${GRAPH}/drive/items/${encodeURIComponent(id)}/content`, { max: MAX_FILE });
    const type = meta.file.mimeType ?? "";
    return TEXTUAL.test(type) ? { name: meta.name, type, link: meta.webUrl, text: buffer.toString("utf8") } : { name: meta.name, type, link: meta.webUrl, base64: buffer.toString("base64") };
  }

  /** A new file (a Google Doc on Google Drive; a text file in "ADT Bot" on OneDrive). */
  async function createFile(params) {
    const a = account(params.account, "drive");
    const name = text(params.name, 200).trim().replace(/[\\/:*?"<>|]/g, "-");
    const content = text(params.content, 2_000_000);
    if (!name) throw new Error("Give the file a name.");
    if (a.provider === "google") {
      const boundary = `adt${Date.now().toString(36)}`;
      const metadata = { name, mimeType: params.format === "text" ? "text/plain" : "application/vnd.google-apps.document" };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
      const { data } = await accounts.api(a.id, "POST", GUPLOAD, { query: { uploadType: "multipart", fields: "id,name,webViewLink" }, body, headers: { "content-type": `multipart/related; boundary=${boundary}` } });
      return { id: data.id, name: data.name, link: data.webViewLink ?? "" };
    }
    const file = /\.\w+$/.test(name) ? name : `${name}.txt`;
    const { data } = await accounts.api(a.id, "PUT", `${GRAPH}/drive/root:/ADT Bot/${encodeURIComponent(file)}:/content`, { body: content, headers: { "content-type": "text/plain" } });
    return { id: data.id, name: data.name, link: data.webUrl ?? "" };
  }

  return { events, createEvent, searchFiles, readFile, createFile };
}

module.exports = { createCalendar };
