require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const express = require("express");
const bodyParser = require("body-parser");
const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    return res.status(200).json({});
  }
  next();
});
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const HISTORY_FILE = path.join(__dirname, "history.json");
const PINJAMAN_FILE = path.join(__dirname, "pinjaman.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const MAX_HISTORY_ITEMS = 10;
const MODEL = "openai/gpt-4o-mini";
// ===== load / save pinjaman =====
function loadPinjaman() {
  try {
    if (!fs.existsSync(PINJAMAN_FILE)) return [];
    const raw = fs.readFileSync(PINJAMAN_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.error("Gagal load pinjaman.json, membuat baru. Error:", e.message);
    return [];
  }
}
function savePinjaman(pinjaman) {
  try {
    fs.writeFileSync(PINJAMAN_FILE, JSON.stringify(pinjaman, null, 2));
  } catch (e) {
    console.error("Gagal simpan pinjaman.json:", e.message);
  }
}


function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { ai_active: true };
    const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
    return JSON.parse(raw || "{\"ai_active\":true}");
  } catch (e) {
    console.error("Gagal load settings.json, membuat baru. Error:", e.message);
    return { ai_active: true };
  }
}
function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error("Gagal simpan settings.json:", e.message);
  }
}

let pinjamanDB = loadPinjaman();
let settings = loadSettings();

// ===== load / save history =====
function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.error("Gagal load history.json, membuat baru. Error:", e.message);
    return {};
  }
}
function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error("Gagal simpan history.json:", e.message);
  }
}

let conversationHistory = loadHistory();

const SYSTEM_PROMPT = {
  role: "system",
  content: `Kamu adalah asisten digital di WhatsApp untuk instansi MRC (Maintenance Repair Calibration), peminjaman barang dan layanan teknis komputer/jaringan di SMKN 1 Subang.
  
  Ruang MRC bertempat di bagian barat sekolah, dekat dengan toilet siswa di pojok.
  
  Tugas kamu adalah membalas setiap pesan dengan ramah, jelas, asyik remaja kekinian, dan profesional, menggunakan bahasa Indonesia yang santai sehari-hari dan mudah dipahami namun tetap sopan, gunakan sedikit emoji juga agar tidak kaku.
  
  Barang-barang yang bisa dipinjam antara lain:
  - Proyektor (sudah termasuk kabel VGA, kabel power, kabel HDMI)
  - Terminal listrik
  - Kabel HDMI 5 meter
  - Layar proyektor
  - Laptop
  - Mouse
  - Tablet
  - Tripod HP

  Catatan penting:
  - Peminjaman hanya bisa dilakukan oleh guru atau staf dengan identitas yang jelas (gunakan ID Card jika diwakili oleh siswa).
  - Peminjaman barang harus kembali dengan kondisi baik dan lengkap.
  - Peminjaman laptop maksimal 10 unit.

  Selain peminjaman barang, MRC juga menyediakan layanan seperti:
  - Perbaikan komputer/laptop
  - Penginstalan software
  - Perbaikan jaringan internet dan perangkatnya
  - Jasa lain yang berkaitan dengan komputer dan jaringan

  Kamu hanya menjawab pesan yang berkaitan dengan konteksnya, jangan sebutkan hal lain selain konteks yang disebutkan. Tanyakan dengan sopan keperluan pengguna dan bantu sesuai prosedur yang berlaku.
  
  Jika ada pesan di luar dari itu, tetap balas dengan sopan dan bantu sesuai kemampuan. Jangan pernah memberikan informasi yang salah atau menyesatkan. Kalau tidak yakin, arahkan ke admin MRC.

  Balas dengan double huruf agar terlihat ramah dalam percakapan seperti remaja pada umumnya.
  Gunakan simbol asterisk jika ingin formatting *bold* di teksnya.
  Jangan pernah menambahkan asterisk di akhir atau awal pesan jika tidak sedang mem-format teks bold.`,
};

// ===== helper untuk memastikan key history valid =====
function ensureUserHistoryKey(key) {
  if (!conversationHistory[key] || !Array.isArray(conversationHistory[key])) {
    conversationHistory[key] = [SYSTEM_PROMPT];
  } else {
    if (
      !conversationHistory[key].length ||
      conversationHistory[key][0].role !== "system"
    ) {
      conversationHistory[key].unshift(SYSTEM_PROMPT);
    }
  }
}

// ===== fungsi untuk memanggil OpenRouter / model =====
async function getAIResponse(messages) {
  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: MODEL,
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    const content =
      res?.data?.choices?.[0]?.message?.content ||
      res?.data?.choices?.[0]?.message?.text;
    return typeof content === "string" && content.length
      ? content
      : "❌ AI tidak memberikan respon yang dapat dibaca";
  } catch (err) {
    console.error("Error dari OpenRouter:", err?.message || err);
    return "❌ Gagal mendapatkan respon AI";
  }
}

// ===== start bot =====
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
  });

  sockGlobal = sock;

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("Scan QR berikut untuk login WhatsApp:");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("Koneksi terputus, reconnect...");
        startBot();
      } else {
        console.log("Anda logout, hapus folder auth_info untuk login ulang.");
      }
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp MRC siap!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const adminNumbers = ["6288706320887@s.whatsapp.net", "6288218366466@s.whatsapp.net"];
      const msg = m.messages[0];
      if (!msg || !msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        "";

      console.log(
        `[${new Date().toLocaleString("en-US", {
          timeZone: "Asia/Jakarta",
        })}] 📩 Pesan dari ${from}: ${text}`
      );

      ensureUserHistoryKey(from);

      try {
        await sock.presenceSubscribe(from);
        await sock.sendPresenceUpdate("composing", from);
      } catch (e) {
        console.warn("Presence update error (ignored):", e.message || e);
      }

      if (text.trim().toLowerCase().startsWith("/msg ")) {
        if (!adminNumbers.includes(from)) {
          await sock.sendMessage(from, { text: "❌ Command /msg hanya bisa digunakan oleh admin." });
          return;
        }
        const match = text.trim().match(/^\/msg\s+(\d{8,15})\s+([\s\S]+)/i);
        if (!match) {
          await sock.sendMessage(from, { text: "Format salah. Contoh: /msg 62812345678 Halo, ini pesan!" });
          return;
        }
        const tujuan = match[1];
        const pesan = match[2];
        const jidTujuan = tujuan.includes("@s.whatsapp.net") ? tujuan : tujuan + "@s.whatsapp.net";
        try {
          await sock.sendMessage(jidTujuan, { text: pesan });
          await sock.sendMessage(from, { text: `✅ Pesan berhasil dikirim ke ${tujuan}` });
        } catch (e) {
          await sock.sendMessage(from, { text: `❌ Gagal kirim pesan ke ${tujuan}: ${e.message || e}` });
        }
        return;
      }

      if (
        text.trim().toLowerCase() === "/reset" ||
        text.trim().toLowerCase() === "hapus history"
      ) {
        conversationHistory[from] = [SYSTEM_PROMPT];
        saveHistory(conversationHistory);
        await sock.sendMessage(from, {
          text: "✅ Riwayat percakapanmu sudah direset.",
        });
        return;
      }

      if (text.trim().toLowerCase() === "/ping") {
        const ms = Date.now() - msg.messageTimestamp * 1000;
        await sock.sendMessage(from, { text: `Pong! 🏓 (${ms} ms)` });
        return;
      }

      if (text.trim().toLowerCase() === "/help") {
        let helpMsg = `🤖 *Command Bot MRC*\n\n`;
        helpMsg += `Ketik pesan apa saja untuk memulai percakapan dengan bot.\n\n`;
        helpMsg += `*Perintah yang tersedia:*\n`;
        helpMsg += `- \`/msg <nomor> <pesan>\` - Mengirim pesan ke nomor tertentu.\n`;
        helpMsg += `- \`/reset\` - Menghapus riwayat percakapan.\n`;
        helpMsg += `- \`/ping\` - Mengecek koneksi.\n`;
        helpMsg += `- \`/help\` - Menampilkan bantuan ini.\n`;
        helpMsg += `- \`/stats\` - Menampilkan statistik bot.\n`;
        helpMsg += `- \`/bc\` - Mengirim pesan broadcast ke semua pengguna.`;
        await sock.sendMessage(from, { text: helpMsg });
        return;
      }

      if (text.trim().toLowerCase() === "/stats") {
        const uptimeMs = Date.now() - BOT_START_TIME;
        const s = Math.floor(uptimeMs / 1000) % 60;
        const m = Math.floor(uptimeMs / 1000 / 60) % 60;
        const h = Math.floor(uptimeMs / 1000 / 60 / 60) % 24;
        const d = Math.floor(uptimeMs / 1000 / 60 / 60 / 24);
        const uptimeStr = `${d} hari, ${h} jam, ${m} menit, ${s} detik`;

        const userCount = Object.keys(conversationHistory).length;

        const totalPeminjaman = pinjamanDB.length;
        const aktif = pinjamanDB.filter(p => p.status === "dipinjam").length;
        const kembali = pinjamanDB.filter(p => p.status === "dikembalikan").length;

        let statsMsg = `📊 *Statistik Bot MRC*\n\n`;
        statsMsg += `⏱️ Uptime: *${uptimeStr}*\n`;
        statsMsg += `👥 User chat: *${userCount}*\n`;
        statsMsg += `📦 Total peminjaman: *${totalPeminjaman}*\n`;
        statsMsg += `🟢 Peminjaman aktif: *${aktif}*\n`;
        statsMsg += `✅ Sudah dikembalikan: *${kembali}*\n`;
        await sock.sendMessage(from, { text: statsMsg });
        return;
      }

      if (text.trim().toLowerCase() === "/bc") {
        if (!adminNumbers.includes(from)) {
          await sock.sendMessage(from, { text: "❌ Command /bc hanya bisa digunakan oleh admin." });
          return;
        }
        // Simpan state broadcast di memory
        if (!global.broadcastState) global.broadcastState = {};
        global.broadcastState[from] = { waiting: true };
        const userCount = Object.keys(conversationHistory).length;
        await sock.sendMessage(from, { text: `📢 Kirim teks broadcast yang akan dikirim ke ${userCount} pengguna.\n\nKetik \`batal\` untuk membatalkan.` });
        return;
      }
      // Jika sedang menunggu pesan broadcast
      if (global.broadcastState && global.broadcastState[from]?.waiting) {
        if (!adminNumbers.includes(from)) {
          global.broadcastState[from] = null;
          await sock.sendMessage(from, { text: "❌ Command broadcast hanya bisa digunakan oleh admin." });
          return;
        }
        if (text.trim().toLowerCase() === "batal") {
          global.broadcastState[from] = null;
          await sock.sendMessage(from, { text: "❌ Broadcast dibatalkan." });
          return;
        }
        const userJids = Object.keys(conversationHistory).filter(jid => jid.endsWith("@s.whatsapp.net"));
        let sentCount = 0;
        for (const jid of userJids) {
          try {
            await sock.sendMessage(jid, { text });
            sentCount++;
          } catch (e) {
            console.error(`❌ Gagal kirim broadcast ke ${jid}:`, e.message || e);
          }
        }
        await sock.sendMessage(from, { text: `✅ Pesan broadcast telah dikirim ke ${sentCount} orang!` });
        global.broadcastState[from] = null;
        return;
      }

      // Hanya balas dengan AI jika settings.ai_active === true
      if (settings.ai_active) {
        conversationHistory[from].push({ role: "user", content: text });

        const historySansSystem = conversationHistory[from].slice(1);
        const messagesToSend = [
          SYSTEM_PROMPT,
          ...historySansSystem.slice(-MAX_HISTORY_ITEMS),
        ];

        const aiReply = await getAIResponse(messagesToSend);

        conversationHistory[from].push({ role: "assistant", content: aiReply });

        const system = conversationHistory[from][0];
        const rest = conversationHistory[from].slice(1).slice(-MAX_HISTORY_ITEMS);
        conversationHistory[from] = [system, ...rest];

        saveHistory(conversationHistory);

        await sock.sendMessage(from, { text: aiReply });

        try {
          await sock.sendPresenceUpdate("available", from);
        } catch (e) {
          console.warn("Presence available error (ignored):", e.message || e);
        }
      } else {
        await sock.sendMessage(from, { text: "Halo, ada yang bisa MRC bantu? 😊" });
      }
    } catch (err) {
      console.error("Handler messages.upsert error:", err);
    }
  });
}

let sockGlobal;
const BOT_START_TIME = Date.now();

// Endpoint untuk peminjaman barang
app.post("/pinjam", async (req, res) => {
  try {
    const { number, name, start_date, due_date, items, id, purpose, notes } = req.body;

    if (!number || !name || !start_date || !due_date || !Array.isArray(items) || !purpose) {
      return res.status(400).json({ error: "Data tidak lengkap" });
    }

    function formatStart(tgl) {
      try {
        const d = new Date(tgl);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd} pukul ${hh}:${min}`;
      } catch {
        return tgl;
      }
    }

    function formatDue(tgl) {
      try {
        const d = new Date(tgl);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      } catch {
        return tgl;
      }
    }

    const pinjamId =
      id || `PMJ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const jid = number.includes("@s.whatsapp.net")
      ? number
      : number.replace(/\D/g, "") + "@s.whatsapp.net";

    const itemsText = items
      .map((it, idx) => `${idx + 1}. ${it.item_name} (${it.qty}x)`)
      .join("\n");

    const startDateText = formatStart(start_date);
    const dueDateText = formatDue(due_date);

    let notesText = notes && notes.trim() ? `📄 Catatan: *${notes}*\n` : "";
    const message = `📢 Yth. *${name}*,\nAnda telah melakukan peminjaman barang dari *MRC*\n\n🗓 Tanggal Pinjam: *${startDateText}*\n📋 Barang yang Dipinjam:\n${itemsText}\n\n📅 Jatuh Tempo: *${dueDateText}*\n📌 Keperluan: *${purpose}*\n${notesText}\n⚠️ Mohon untuk mengembalikan barang tepat waktu dalam keadaan *lengkap* dan *baik* sesuai saat dipinjam.\n\n_Maintenance Repair Calibration_ 🛠️`;

    pinjamanDB.push({
      id: pinjamId,
      number,
      name,
      start_date,
      due_date,
      items,
      purpose,
      notes: notes || "",
      status: "dipinjam",
      returned_at: null,
    });
    savePinjaman(pinjamanDB);

    ensureUserHistoryKey(jid);
    conversationHistory[jid].push({ role: "assistant", content: message });
    const system = conversationHistory[jid][0];
    const rest = conversationHistory[jid].slice(1).slice(-MAX_HISTORY_ITEMS);
    conversationHistory[jid] = [system, ...rest];
    saveHistory(conversationHistory);

    await sockGlobal.sendMessage(jid, { text: message });

    const startTime = new Date(start_date).getTime();
    const dueTime = new Date(due_date).getTime();
    let timeoutMs = dueTime - startTime;
    if (timeoutMs < 60000) timeoutMs = 8 * 60 * 60 * 1000;

    let s = Math.floor(timeoutMs / 1000) % 60;
    let m = Math.floor(timeoutMs / 1000 / 60) % 60;
    let h = Math.floor(timeoutMs / 1000 / 60 / 60) % 24;
    let d = Math.floor(timeoutMs / 1000 / 60 / 60 / 24);
    let durasiStr = `${d} hari, ${h} jam, ${m} menit, ${s} detik`;

    setTimeout(async () => {
      const latestPinjaman = pinjamanDB.find((p) => p.id === pinjamId);
      if (latestPinjaman && latestPinjaman.status !== "dikembalikan") {
        const reminderMsg = `📢 Yth. *${name}*,\nAnda *belum mengembalikan* barang yang dipinjam dari *MRC*\n\n🗓 Tanggal Pinjam: *${startDateText}*\n📋 Barang yang Dipinjam:\n${itemsText}\n\n📅 Jatuh Tempo: *${dueDateText}*\n📌 Keperluan: *${purpose}*\n${notesText}\n⚠️ Mohon untuk mengembalikan barang tepat waktu dalam keadaan *lengkap* dan *baik* sesuai saat dipinjam.\n\n_Maintenance Repair Calibration_ 🛠️\n\n> _Abaikan pesan ini jika sudah mengembalikan_`;
        try {
          await sockGlobal.sendMessage(jid, { text: reminderMsg });
          console.log(
            `[${new Date().toLocaleString("en-US", {
              timeZone: "Asia/Jakarta",
            })}] 🔔 Pengingat pengembalian dikirim ke ${number}`
          );
        } catch (e) {
          console.error("Gagal kirim reminder pengembalian:", e.message || e);
        }
      }
    }, timeoutMs);

    console.log(
      `[${new Date().toLocaleString("en-US", {
        timeZone: "Asia/Jakarta",
      })}] ⏳ Pengingat pengembalian akan dikirim dalam ${durasiStr} ke ${number}`
    );

    res.json({
      status: "Pesan berhasil dikirim",
      sent_to: number,
      id: pinjamId,
    });
    console.log(
      `[${new Date().toLocaleString("en-US", {
        timeZone: "Asia/Jakarta",
      })}] ✅ Pesan pemberitahuan peminjaman dikirim ke ${number}`
    );
  } catch (err) {
    console.error("Error /pinjam:", err);
    res.status(500).json({ error: "Gagal mengirim pesan" });
  }
});

app.post("/kembali", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: "ID peminjaman wajib diisi" });
    }
    const idx = pinjamanDB.findIndex((p) => p.id === id);
    if (idx === -1) {
      return res.status(404).json({ error: "ID peminjaman tidak ditemukan" });
    }
    if (pinjamanDB[idx].status === "dikembalikan") {
      return res
        .status(400)
        .json({ error: "Barang sudah dikembalikan sebelumnya" });
    }
    pinjamanDB[idx].status = "dikembalikan";
    pinjamanDB[idx].returned_at = new Date().toISOString();
    const { number, name, items, start_date, purpose, notes } = pinjamanDB[idx];
    const jid = number.includes("@s.whatsapp.net")
      ? number
      : number.replace(/\D/g, "") + "@s.whatsapp.net";
    const itemsText = items
      .map((it, idx) => `${idx + 1}. ${it.item_name} (${it.qty}x)`)
      .join("\n");
    // Hitung durasi peminjaman
    const startTime = new Date(pinjamanDB[idx].start_date).getTime();
    const returnedTime = new Date(pinjamanDB[idx].returned_at).getTime();
    let durationMs = returnedTime - startTime;
    if (durationMs < 0) durationMs = 0;
    let m = Math.floor(durationMs / 1000 / 60) % 60;
    let h = Math.floor(durationMs / 1000 / 60 / 60) % 24;
    let d = Math.floor(durationMs / 1000 / 60 / 60 / 24);
    let durasiStr;
    if (d === 0) {
      durasiStr = `${h} jam, ${m} menit`;
    } else {
      durasiStr = `${d} hari, ${h} jam, ${m} menit`;
    }

    const startDateText = (() => {
      try {
        const d = new Date(start_date);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd} pukul ${hh}:${min}`;
      } catch {
        return start_date;
      }
    })();
    let notesText = notes && notes.trim() ? `📄 Catatan: *${notes}*\n` : "";

    const message = `✅ Yth. *${name}*,\nTerima kasih sudah mengembalikan barang ke *MRC*!\n\n📋 Barang yang dikembalikan:\n${itemsText}\n\n🗓 Tanggal Pinjam: *${startDateText}*\n📌 Keperluan: *${purpose}*\n${notesText}\n⏳ Durasi peminjaman: *${durasiStr}*\n\nBarang sudah diterima dalam keadaan baik dan lengkap yaa. Kalau butuh bantuan atau mau pinjam lagi, silakan hubungi MRC kapan ajaa 😁✨\n\n_Maintenance Repair Calibration_ 🛠️`;

    try {
      await sockGlobal.sendMessage(jid, { text: message });
      ensureUserHistoryKey(jid);
      conversationHistory[jid].push({ role: "assistant", content: message });
      const system = conversationHistory[jid][0];
      const rest = conversationHistory[jid].slice(1).slice(-MAX_HISTORY_ITEMS);
      conversationHistory[jid] = [system, ...rest];
      saveHistory(conversationHistory);
    } catch (e) {
      console.error("Gagal kirim konfirmasi pengembalian:", e.message || e);
    }
    savePinjaman(pinjamanDB);
    res.json({ status: "Barang telah ditandai sebagai dikembalikan", id });
    console.log(
      `[${new Date().toLocaleString("en-US", {
        timeZone: "Asia/Jakarta",
      })}] ✅ Barang dengan ID ${id} telah dikembalikan.`
    );
  } catch (err) {
    console.error("Error /kembali:", err);
    res.status(500).json({ error: "Gagal menandai pengembalian" });
  }
});

app.post("/pengingat", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: "ID peminjaman wajib diisi" });
    }
    const pinjaman = pinjamanDB.find((p) => p.id === id);
    if (!pinjaman) {
      return res.status(404).json({ error: "ID peminjaman tidak ditemukan" });
    }
    if (pinjaman.status === "dikembalikan") {
      return res.status(400).json({ error: "Barang sudah dikembalikan sebelumnya" });
    }
    const { number, name, items, start_date, due_date, purpose, notes } = pinjaman;
    const jid = number.includes("@s.whatsapp.net")
      ? number
      : number.replace(/\D/g, "") + "@s.whatsapp.net";
    const itemsText = items
      .map((it, idx) => `${idx + 1}. ${it.item_name} (${it.qty}x)`)
      .join("\n");
    function formatStart(tgl) {
      try {
        const d = new Date(tgl);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd} pukul ${hh}:${min}`;
      } catch {
        return tgl;
      }
    }
    function formatDue(tgl) {
      try {
        const d = new Date(tgl);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      } catch {
        return tgl;
      }
    }
    const startDateText = formatStart(start_date);
    const dueDateText = formatDue(due_date);
    let notesText = notes && notes.trim() ? `📄 Catatan: *${notes}*\n` : "";
    const reminderMsg = `📢 Yth. *${name}*,\nAnda *belum mengembalikan* barang yang dipinjam dari *MRC*\n\n🗓 Tanggal Pinjam: *${startDateText}*\n📋 Barang yang Dipinjam:\n${itemsText}\n\n📅 Jatuh Tempo: *${dueDateText}*\n📌 Keperluan: *${purpose}*\n${notesText}\n⚠️ Mohon untuk mengembalikan barang tepat waktu dalam keadaan *lengkap* dan *baik* sesuai saat dipinjam.\n\n_Maintenance Repair Calibration_ 🛠️\n\n> _Abaikan pesan ini jika sudah mengembalikan_`;
    try {
      await sockGlobal.sendMessage(jid, { text: reminderMsg });
      ensureUserHistoryKey(jid);
      conversationHistory[jid].push({ role: "assistant", content: reminderMsg });
      const system = conversationHistory[jid][0];
      const rest = conversationHistory[jid].slice(1).slice(-MAX_HISTORY_ITEMS);
      conversationHistory[jid] = [system, ...rest];
      saveHistory(conversationHistory);
      res.json({ status: "Pengingat berhasil dikirim", id });
      console.log(
        `[${new Date().toLocaleString("en-US", {
          timeZone: "Asia/Jakarta",
        })}] 🔔 Pengingat pengembalian dikirim ke ${number}`
      );
    } catch (e) {
      console.error("Gagal kirim pengingat:", e.message || e);
      res.status(500).json({ error: "Gagal mengirim pengingat" });
    }
  } catch (err) {
    console.error("Error /pengingat:", err);
    res.status(500).json({ error: "Gagal memproses pengingat" });
  }
});


// Endpoint untuk mengaktifkan/mematikan AI
app.post("/ai", (req, res) => {
  try {
    const { active } = req.body;
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "active harus boolean (true/false)" });
    }
    settings.ai_active = active;
    saveSettings(settings);
    res.json({ status: "AI status updated", ai_active: settings.ai_active });
    console.log(`AI status diubah menjadi: ${settings.ai_active ? "aktif" : "nonaktif"}`);
  } catch (err) {
    console.error("Error /ai:", err);
    res.status(500).json({ error: "Gagal update AI status" });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server API Bot MRC berjalan di port 3000");
});

startBot().catch((err) => console.error("Start bot error:", err));