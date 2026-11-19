// Patches files inside T3 Code's app.asar by appending new bytes and repointing
// header entries. Every other file stays byte-for-byte identical.
// usage: node patch-asar.mjs <in.asar> <out.asar> <inject.js>
//
// 1. apps/server/dist/client/index.html  -> inject the sidebar sync icon (inject.js)
// 2. server importer fixes (see SERVER_PATCHES): one T3 thread per Claude session,
//    never re-import a session T3 already has, skip slash-command-only sessions,
//    only import recent sessions, and don't force imported chats to "settled".
// Every anchor must match exactly once, or nothing is written.
import fs from "node:fs";
import crypto from "node:crypto";
const [, , src, dst, injectPath] = process.argv;
const MARK_START = "<!-- t3ccsync:start -->", MARK_END = "<!-- t3ccsync:end -->";
const RECENT_DAYS = 14;

const SERVER_PATCHES = [
  {
    file: "apps/server/dist/runtimeLayer-DiBNK4ph.mjs",
    match: /^apps\/server\/dist\/runtimeLayer-[\w-]+\.mjs$/,
    edits: [
      // Your Claude profiles share ~/.claude/projects, so the same session was
      // imported once per profile. Key sessions by id alone.
      ["const sessionKey = `${completedSource.providerInstanceId}\\0${completedSource.providerSessionId}`;",
       "const sessionKey = `${completedSource.provider}\\0${completedSource.providerSessionId}`;"],
      ["const sessionKey = `${parsedThread.providerInstanceId}\\0${parsedThread.providerSessionId}`;",
       "const sessionKey = `${parsedThread.source}\\0${parsedThread.providerSessionId}`;"],
      // Skip sessions with no real conversation (/login, /recap ...) and old ones.
      ['if (parsedThread === null) return some({ _tag: "Skipped" });',
       'if (parsedThread === null) return some({ _tag: "Skipped" });\n' +
       '\t\t\tif (parsedThread.source === "claudeAgent") { /* t3ccsync */\n' +
       '\t\t\t\tconst t3ccReal = parsedThread.messages.filter((m) => m.role === "user" && !/^\\s*<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/.test(m.text));\n' +
       '\t\t\t\tconst t3ccAnswered = parsedThread.messages.some((m) => m.role === "assistant" && m.text.trim() !== "");\n' +
       `\t\t\t\tconst t3ccAge = Date.now() - Date.parse(String(parsedThread.updatedAt));\n` +
       `\t\t\t\tif (t3ccReal.length === 0 || !t3ccAnswered || (t3ccAge > ${RECENT_DAYS} * 864e5) || /^\\s*<command-/.test(parsedThread.title)) return some({ _tag: "Skipped" });\n` +
       '\t\t\t}'],
      // Imported chats show up as normal (unsettled) threads.
      ['\t\t\t\t\t\tsettledOverride: "settled",\n\t\t\t\t\t\tsettledAt: updatedAt,\n\t\t\t\t\t\tunsettledAt: null,\n\t\t\t\t\t\tsnoozedUntil: null,\n\t\t\t\t\t\tsnoozedAt: null,\n\t\t\t\t\t\tpinnedAt: null,\n\t\t\t\t\t\tpinOrderKey: null,\n\t\t\t\t\t\tactiveOrderKey: null,\n\t\t\t\t\t\tlastVisitedAt: null,\n\t\t\t\t\t\tdeletedAt: null\n\t\t\t\t\t};\n\t\t\t\t\tconst providerThread = {',
       '\t\t\t\t\t\tsettledOverride: null,\n\t\t\t\t\t\tsettledAt: null,\n\t\t\t\t\t\tunsettledAt: null,\n\t\t\t\t\t\tsnoozedUntil: null,\n\t\t\t\t\t\tsnoozedAt: null,\n\t\t\t\t\t\tpinnedAt: null,\n\t\t\t\t\t\tpinOrderKey: null,\n\t\t\t\t\t\tactiveOrderKey: null,\n\t\t\t\t\t\tlastVisitedAt: null,\n\t\t\t\t\t\tdeletedAt: null\n\t\t\t\t\t};\n\t\t\t\t\tconst providerThread = {'],
    ],
  },
  {
    file: "apps/server/dist/ManagedEndpointRuntime-Bw9ErxcQ.mjs",
    match: /^apps\/server\/dist\/ManagedEndpointRuntime-[\w-]+\.mjs$/,
    edits: [
      // A session T3 already has (under any Claude profile, in any live thread)
      // is never imported again.
      ["                AND provider_instance_id = ${imported.providerInstanceId}\n                AND thread_id IS NOT ${imported.appThreadId}\n",
       "                AND thread_id IS NOT ${imported.appThreadId}\n                AND thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL)\n"],
    ],
  },
];

const buf = fs.readFileSync(src);
const headerSize = buf.readUInt32LE(4);
const strLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + strLen).toString("utf8"));
const dataStart = 8 + headerSize;

function entry(p) {
  let node = header;
  for (const part of p.split("/")) {
    node = node.files?.[part];
    if (!node) throw new Error(`entry not found: ${p}`);
  }
  if (node.unpacked) throw new Error(`${p} is unpacked; unexpected`);
  return node;
}
function read(node) {
  const off = dataStart + Number(node.offset);
  return buf.subarray(off, off + node.size).toString("utf8");
}
function listFiles(dir) {
  const node = entry(dir);
  return Object.keys(node.files).map((k) => `${dir}/${k}`);
}

let dataLen = 0;
(function walk(n) {
  if (n.files) for (const k in n.files) walk(n.files[k]);
  else if (!n.unpacked && n.offset !== undefined) dataLen = Math.max(dataLen, Number(n.offset) + n.size);
})(header);
const appended = [];
function replace(node, text) {
  const bytes = Buffer.from(text, "utf8");
  node.offset = String(dataLen + appended.reduce((a, b) => a + b.length, 0));
  node.size = bytes.length;
  if (node.integrity) {
    const blockSize = node.integrity.blockSize || 4 * 1024 * 1024;
    const blocks = [];
    for (let i = 0; i < bytes.length; i += blockSize)
      blocks.push(crypto.createHash("sha256").update(bytes.subarray(i, i + blockSize)).digest("hex"));
    node.integrity = { algorithm: "SHA256", hash: crypto.createHash("sha256").update(bytes).digest("hex"), blockSize, blocks };
  }
  appended.push(bytes);
}

// 1. client index.html
{
  const p = "apps/server/dist/client/index.html";
  const node = entry(p);
  let html = read(node);
  const s = html.indexOf(MARK_START), e = html.indexOf(MARK_END);
  if (s !== -1 && e !== -1) html = html.slice(0, s) + html.slice(e + MARK_END.length);
  if (!html.includes("</head>")) throw new Error("no </head> in index.html");
  const js = fs.readFileSync(injectPath, "utf8").replace(/<\/script/gi, "<\\/script");
  html = html.replace("</head>", `${MARK_START}<script>${js}</script>${MARK_END}</head>`);
  replace(node, html);
  console.log(`patched ${p}`);
}

// 2. server importer
const serverFiles = listFiles("apps/server/dist");
for (const patch of SERVER_PATCHES) {
  const matches = serverFiles.filter((f) => patch.match.test(f) && patch.edits.some(([from, to]) => { const t = read(entry(f)); return t.includes(from) || t.includes(to); }));
  if (matches.length !== 1) throw new Error(`expected one file like ${patch.file} with the importer code, found ${matches.length}`);
  const node = entry(matches[0]);
  let text = read(node);
  for (const [from, to] of patch.edits) {
    if (text.includes(to)) continue; // already applied
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`${matches[0]}: anchor found ${count} times (T3 changed?):\n${from.slice(0, 120)}`);
    text = text.replace(from, () => to);
  }
  replace(node, text);
  console.log(`patched ${matches[0]} (${patch.edits.length} edits)`);
}

const json = Buffer.from(JSON.stringify(header), "utf8");
const padded = (json.length + 3) & ~3;
const headerPickle = Buffer.alloc(8 + padded);
headerPickle.writeUInt32LE(4 + padded, 0);
headerPickle.writeUInt32LE(json.length, 4);
json.copy(headerPickle, 8);
const sizePickle = Buffer.alloc(8);
sizePickle.writeUInt32LE(4, 0);
sizePickle.writeUInt32LE(headerPickle.length, 4);
fs.writeFileSync(dst, Buffer.concat([sizePickle, headerPickle, buf.subarray(dataStart, dataStart + dataLen), ...appended]));
console.log(`wrote ${dst}`);
