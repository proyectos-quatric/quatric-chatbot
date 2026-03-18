// ============================================================
// QUATRIC SV — Chatbot Server v2.0
// ============================================================
// BUGS CORREGIDOS vs v1:
//
// [BUG 1] Modelo inexistente: "gpt-5.4-mini" → corregido a "gpt-4o-mini"
// [BUG 2] API incorrecta: openai.responses.create() no existe
//         → corregido a openai.chat.completions.create()
// [BUG 3] Sin historial: IA no recordaba mensajes anteriores
//         → se guarda session.history y se manda en cada request
// [BUG 4] Memory leak: sessions = {} nunca se limpia
//         → Map + TTL de 30min + cleanup automático cada 10min
// [BUG 5] Lead detection rota: buscaba "nombre"+"tel"+"proyecto"
//         en un solo mensaje (nunca ocurre)
//         → detecta completitud acumulada del objeto session.data
// [BUG 6] Solo disparaba email para residencial, nunca industrial
//         → sendLeadEmail() aplica para ambos tipos
// [BUG 7] Email enviaba solo el último mensaje, sin datos ni conversación
//         → email HTML con tabla de datos + transcripción completa
// [BUG 8] session.nombre = message (guardaba mensaje completo)
//         → regex extrae solo el nombre real
// [BUG 9] Ubicación detectaba solo "zacamil" y "san salvador"
//         → cubre todos los departamentos y ciudades de El Salvador
// [BUG 10] System prompt estático: se mandaba el prompt completo
//          en cada request aunque ya se tuvieran todos los datos
//          → buildDynamicPrompt() genera un prompt mínimo y contextual
// [BUG 11] Campos duplicados en prompt (proyecto y tipo × 2)
//          → eliminado, prompt ahora es limpio y sin repeticiones
//
// MEJORAS NUEVAS:
// - Rate limiting por IP (20 req/min)
// - Validación de input (longitud, tipo)
// - max_tokens: 150 → respuestas cortas, eficiencia de tokens
// - temperature: 0.35 → más determinístico y preciso
// - Regex para teléfonos salvadoreños (7xxx-xxxx, 2xxx-xxxx)
// - Extracción de capacidad (kVA/A), tensión (V), fecha
// - buildDynamicPrompt() pide UN dato a la vez, en orden de prioridad
// - isLeadComplete() valida por tipo antes de enviar email
// - /health endpoint para monitoreo
// - PORT configurable por env var
// ============================================================

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());

// ── OpenAI ───────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Email ────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   "smtp.gmail.com",
  port:   587,          // 465 bloqueado en Render free → usar 587
  secure: false,        // STARTTLS en 587
  family: 4,            // forzar IPv4 — evita ENETUNREACH en Render
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 10000,
  greetingTimeout:   10000,
  socketTimeout:     15000,
});

// ============================================================
// SESSION STORE con TTL
// ============================================================
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutos de inactividad

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      data: {
        nombre:    null,
        telefono:  null,
        ubicacion: null,
        proyecto:  null,
        tipo:      null,
        capacidad: null,
        tension:   null,
        fecha:     null,
        correo:    null,
      },
      history:       [],    // historial completo para la IA
      leadSent:      false,
      techQuestions: 0,     // contador de consultas técnicas respondidas
      createdAt:     Date.now(),
      lastActivity:  Date.now(),
    });
  }
  const s = sessions.get(id);
  s.lastActivity = Date.now();
  return s;
}

// Limpieza automática cada 10 min
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) sessions.delete(id);
  }
}, 10 * 60 * 1000);

// ============================================================
// EXTRACCIÓN DE DATOS (regex — sin depender de la IA)
// ============================================================
const LOCATION_RE = /\b(san salvador|santa ana|san miguel|sonsonate|chalatenango|cuscatl[áa]n|la libertad|la paz|la uni[óo]n|moraz[áa]n|san vicente|usulut[áa]n|ahuachap[áa]n|caba[ñn]as|santa tecla|mejicanos|soyapango|apopa|ilopango|antiguo cuscatl[áa]n|ciudad delgado|zacamil|merliot|lourdes|escal[óo]n|planes de renderos|colonia|residencial|urb\.?|urbanizaci[óo]n)\b/i;

const PHONE_RE  = /\b([267]\d{3}[\s\-]?\d{4})\b/;
const NAME_RE   = /(?:(?:me llamo|soy|mi nombre es|ll[áa]mame)\s+)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}){0,2})|^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}){1,2})\s*[,\.]/im;
const NAME_BLOCKLIST = /^(no|si|ok|ya|hola|buenas|gracias|bien|mal|claro|perfecto|listo|dale|bueno|quiero|tengo|necesito|eso|esto|aqui|ahi)/i;
const CAP_RE    = /(\d+[\.,]?\d*)\s*(kva|kw|amp(?:erios?|eres?)?|hp|watts?|vatios?)/i;
const TENSION_RE= /(\d{2,4})\s*v(?:oltios?|olts?)?\b/i;
const DATE_RE   = /\b(hoy|ma[ñn]ana|esta semana|pr[óo]xima semana|este mes|pr[óo]ximo mes|urgente|lo antes posible|asap|\d+\s*d[íi]as?|\d+\s*semanas?|\d+\s*meses?)\b/i;
const EMAIL_RE  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

const TIPO_RESIDENCIAL_RE = /\b(casa|hogar|vivien\w*|residen\w*|apartamento|apto|domicil\w*|habitaci[óo]n|cuarto)\b/i;
const TIPO_INDUSTRIAL_RE  = /\b(empresa|industrial|planta|f[áa]brica|gasolinera|bodega|negocio|comercial|taller|hotel|hospital|subestaci[óo]n|distribuci[óo]n|nave|almac[eé]n|local|sala de ventas|sala|oficina|consultorio|cl[íi]nica|restaurante|tienda|farmacia|supermercado|centro comercial|edificio|escuela|colegio|instituto|universidad)\b/i;

// Capitalizar nombre
function capitalizeName(str) {
  return str.trim().split(/\s+/)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

// Inferir qué campo preguntó el bot en su último mensaje
function lastBotAskedFor(history) {
  const last = [...history].reverse().find(m => m.role === "assistant");
  if (!last) return null;
  const t = last.content.toLowerCase();
  if (/nombre completo|tu nombre|cómo te llamas/.test(t))  return "nombre";
  if (/tel[eé]fono|número de contacto|número cel/.test(t)) return "telefono";
  if (/correo|email/.test(t))                              return "correo";
  if (/municipio|colonia|zona|ubicaci[oó]n|d[oó]nde est[aá]/.test(t)) return "ubicacion";
  if (/kva|amperios|capacidad|carga/.test(t))              return "capacidad";
  if (/voltios|tensi[oó]n|nivel de voltaje/.test(t))       return "tension";
  if (/proyecto|instalaci[oó]n|qu[eé] necesitas|qu[eé] trabajo/.test(t)) return "proyecto";
  if (/cu[aá]ndo|fecha|plazo/.test(t))                    return "fecha";
  return null;
}

function extractData(msg, session) {
  const d = session.data;
  const asked = lastBotAskedFor(session.history); // campo que el bot acaba de pedir
  const raw   = msg.trim();

  // ── EXTRACCIÓN DIRECTA POR CONTEXTO ──────────────────────────────────────
  // Si el bot preguntó algo específico y el usuario responde algo corto (≤8 palabras),
  // intentar almacenarlo directamente en ese campo.

  if (asked === "nombre" && !d.nombre) {
    const palabras = raw.split(/\s+/);
    const soloLetras = /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+$/;
    if (
      palabras.length >= 1 && palabras.length <= 4 &&
      palabras.every(p => soloLetras.test(p) && p.length >= 2) &&
      !NAME_BLOCKLIST.test(palabras[0])
    ) {
      d.nombre = capitalizeName(raw);
    }
  }

  if (asked === "telefono" && !d.telefono) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 11) d.telefono = digits;
  }

  if (asked === "correo" && !d.correo) {
    // Intentar corregir errores comunes (gmailcom → gmail.com)
    let correoCandidate = raw.toLowerCase()
      .replace(/gmailcom$/,  "gmail.com")
      .replace(/hotmailcom$/, "hotmail.com")
      .replace(/yahoocom$/,  "yahoo.com")
      .replace(/outlookcom$/, "outlook.com");
    if (EMAIL_RE.test(correoCandidate)) {
      d.correo = correoCandidate.match(EMAIL_RE)[0];
    } else if (raw.includes("@")) {
      // Guardar aunque sea inválido — mejor tenerlo que no
      d.correo = correoCandidate.trim().slice(0, 80);
    }
  }

  if (asked === "ubicacion" && !d.ubicacion) {
    if (raw.length >= 3) d.ubicacion = raw.slice(0, 120);
  }

  if (asked === "capacidad" && !d.capacidad) {
    const m = raw.match(CAP_RE);
    if (m) {
      d.capacidad = m[0];
    } else if (/^\d+([\.,]\d+)?$/.test(raw)) {
      // Número solo sin unidad — asume kVA por contexto
      d.capacidad = raw + " kVA";
    }
  }

  if (asked === "tension" && !d.tension) {
    const m = raw.match(TENSION_RE);
    if (m) d.tension = m[0];
    else if (/^\d{2,4}$/.test(raw)) d.tension = raw + "V";
  }

  if (asked === "proyecto" && !d.proyecto) {
    if (raw.length >= 3) d.proyecto = raw.slice(0, 200);
  }

  if (asked === "fecha" && !d.fecha) {
    if (raw.length >= 2) d.fecha = raw.slice(0, 60);
  }

  // ── EXTRACCIÓN POR REGEX (siempre, para mensajes con contenido rico) ─────

  // Tipo
  if (!d.tipo) {
    if (TIPO_RESIDENCIAL_RE.test(raw)) d.tipo = "residencial";
    else if (TIPO_INDUSTRIAL_RE.test(raw)) d.tipo = "industrial";
  }

  // Teléfono
  if (!d.telefono) {
    const m = raw.match(PHONE_RE);
    if (m) d.telefono = m[1].replace(/[\s\-]/g, "");
  }

  // Correo
  if (!d.correo) {
    const m = raw.match(EMAIL_RE);
    if (m) d.correo = m[0].toLowerCase();
  }

  // Nombre con trigger ("soy X", "me llamo X")
  if (!d.nombre) {
    const m = raw.match(NAME_RE);
    if (m) {
      const candidato = (m[1] || m[2]).trim();
      if (!NAME_BLOCKLIST.test(candidato)) d.nombre = candidato;
    }
    // Fallback 2-3 palabras solo letras
    if (!d.nombre) {
      const palabras = raw.split(/\s+/);
      const soloLetras = /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ]+$/;
      const candidato = raw.trim().toLowerCase();
      if (
        palabras.length >= 2 && palabras.length <= 3 &&
        palabras.every(p => soloLetras.test(p) && p.length >= 2) &&
        !NAME_BLOCKLIST.test(palabras[0]) &&
        !LOCATION_RE.test(candidato) &&          // no es una ubicación conocida
        candidato !== (d.ubicacion || "").toLowerCase()  // no es lo mismo que ya guardamos
      ) {
        d.nombre = capitalizeName(raw);
      }
    }
  }

  // Capacidad
  if (!d.capacidad) {
    const m = raw.match(CAP_RE);
    if (m) d.capacidad = m[0];
  }

  // Tensión
  if (!d.tension) {
    const m = raw.match(TENSION_RE);
    if (m) d.tension = m[0];
  }

  // Ubicación por keywords conocidas
  if (!d.ubicacion && LOCATION_RE.test(raw)) {
    const match = raw.match(LOCATION_RE);
    if (match) d.ubicacion = match[0];
  }

  // Fecha
  if (!d.fecha) {
    const m = raw.match(DATE_RE);
    if (m) d.fecha = m[0];
  }

  // Proyecto
  if (!d.proyecto) {
    const proyectoRE = /\b(instalaci[óo]n|cableado|transformador|tablero|panel|acometida|circuito|mantenimiento|revisi[óo]n|ampliaci[óo]n)\b/i;
    if (proyectoRE.test(raw)) {
      d.proyecto = raw.split(".")[0].slice(0, 120);
    }
  }
}


// ============================================================
// COMPLETITUD DEL LEAD
// ============================================================
function isLeadComplete(data) {
  // Lead completo con tipo definido
  const base = data.nombre && data.telefono && data.correo && data.proyecto && data.ubicacion;
  if (data.tipo === "residencial") return !!base;
  if (data.tipo === "industrial")  return !!(base && (data.capacidad || data.tension));

  // Fallback: tipo desconocido pero tenemos nombre + teléfono + correo
  if (data.nombre && data.telefono && data.correo) return true;

  return false;
}

// ============================================================
// DYNAMIC SYSTEM PROMPT — crece/shrinks según contexto
// El truco: mientras más datos tenemos, el prompt es MÁS CORTO
// y más enfocado. Mínimo de tokens posible en cada etapa.
// ============================================================
function buildDynamicPrompt(data, techQuestions = 0) {
  const d = data;

  // ── Regla global: límite de consultas técnicas ────────────
  const TECH_LIMIT = 2;
  const techLimitRule = techQuestions >= TECH_LIMIT
    ? `REGLA DE TOPE TÉCNICO (ACTIVA): Ya respondiste ${techQuestions} consultas técnicas gratuitas.
Si el usuario hace otra pregunta técnica específica (cálculos, normas, materiales, dimensionamiento),
NO la respondas. En su lugar di algo como:
"Para ese nivel de detalle, lo mejor es que uno de nuestros ingenieros te asesore directamente. ¿Te gustaría que te contactemos?" y ofrece dejar sus datos.`
    : `REGLA DE CONSULTAS TÉCNICAS: Puedes responder máximo ${TECH_LIMIT - techQuestions} consulta(s) técnica(s) más.
Si respondes una, hazlo en máximo 50 caracteres — solo el dato clave, sin explicaciones largas.
Ejemplo correcto: "Caída ~0.3V. ¿Es para tu casa o negocio?"
Ejemplo incorrecto: párrafos de cálculo detallado.`;

  // ── Etapa 0: tipo desconocido ─────────────────────────────
  if (!d.tipo) {
    return `Eres el asistente virtual de QUATRIC, empresa salvadoreña de ingeniería eléctrica.
Servicios: instalaciones eléctricas, tableros, acometidas, mantenimiento y proyectos eléctricos para casas y empresas.

MISIÓN en esta etapa: entender qué necesita el cliente y clasificarlo como residencial o industrial.

REGLAS:
- Si el cliente saluda o da un mensaje vago (hola, adf, ok, etc.), responde calurosamente,
  preséntate brevemente y pregunta en qué puedes ayudarle HOY. NO preguntes aún casa/negocio.
- Si el cliente describe una necesidad, infiere el tipo por contexto (casa/hogar = residencial,
  empresa/negocio/planta = industrial). Si es obvio, NO preguntes — clasifica y avanza.
- Solo pregunta "¿Es para tu casa o para un negocio?" si describió una necesidad pero
  el tipo sigue siendo ambiguo.
- Si el cliente está confundido o hace preguntas generales, explica brevemente qué hace
  QUATRIC y luego pregunta en qué le puedes ayudar.
- Si el cliente dice algo absurdo, fuera de tema o gracioso (comida, chistes, temas personales, etc.),
  respóndele con UNA frase corta y cálida que reconozca lo que dijo (puedes usar 1 emoji si encaja),
  y redirige suavemente hacia temas eléctricos. Ejemplo:
  "¡Con ese cafecito se trabaja mejor! ☕ ¿En qué te puedo ayudar hoy con tu instalación eléctrica?"
- NUNCA repitas la misma pregunta dos veces seguidas.
- IMPORTANTE: Si ya tienes nombre, teléfono, proyecto y ubicación pero NO tienes correo,
  pide el correo electrónico antes de cerrar la conversación. Es obligatorio para enviar
  su información a un representante. Ejemplo: "¿Y a qué correo te enviamos la confirmación?"
- No cierres ni des por terminada la conversación sin haber obtenido el correo electrónico.
- Máximo 2 líneas. Tono cálido, humano y directo.

${techLimitRule}`;
  }

  // ── Datos ya recopilados (solo los no-nulos) ───────────────
  const recopilados = Object.entries(d)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" | ");

  // ── Datos faltantes según tipo ────────────────────────────
  const faltanResidencial = [
    !d.proyecto   && "proyecto (¿qué trabajo eléctrico necesita?)",
    !d.ubicacion  && "ubicación (municipio o colonia)",
    !d.nombre     && "nombre completo",
    !d.telefono   && "número de teléfono",
    !d.correo     && "correo electrónico",
  ].filter(Boolean);

  const faltanIndustrial = [
    !d.proyecto   && "tipo de instalación o trabajo requerido",
    !d.ubicacion  && "ubicación del proyecto",
    !d.nombre     && "nombre completo del contacto",
    !d.telefono   && "número de teléfono",
    !d.correo     && "correo electrónico",
    !d.capacidad  && "capacidad estimada (kVA o amperios)",
    !d.tension    && "nivel de tensión (voltios)",
    !d.fecha      && "fecha estimada de inicio del proyecto",
  ].filter(Boolean);

  const faltan = d.tipo === "residencial" ? faltanResidencial : faltanIndustrial;

  // ── Etapa final: lead completo ────────────────────────────
  if (faltan.length === 0) {
    return `Eres el asistente de QUATRIC. Lead ${d.tipo} COMPLETO.
Datos capturados: ${recopilados}.
Agradece al cliente, confirma en 1 línea los datos clave (nombre, proyecto, ubicación)
y dile que un asesor de QUATRIC lo contactará pronto. Tono cálido. Máximo 3 líneas.

${techLimitRule}`;
  }

  // ── Etapa intermedia: pedir UN dato a la vez ──────────────
  const siguiente = faltan[0];
  const cuantosFaltan = faltan.length;

  // Lista clara de lo que ya está confirmado para evitar re-preguntas
  const confirmados = Object.entries(d)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: "${v}"`)
    .join(", ");

  return `Eres el asistente de QUATRIC (ingeniería eléctrica, El Salvador). Cliente ${d.tipo}.
DATOS YA CONFIRMADOS (NO volver a preguntar NINGUNO de estos): ${confirmados || "ninguno aún"}.
Faltan ${cuantosFaltan} datos. ÚNICO DATO A OBTENER AHORA: "${siguiente}".

CONTEXTO: Estás recopilando información para enviarla a un representante de QUATRIC.
Si el cliente pregunta para qué, di: "Para que nuestro representante te contacte y dé seguimiento."

REGLAS — sin excepciones:
1. Pregunta SOLO por "${siguiente}". No preguntes nada más.
2. Si algún dato de DATOS YA CONFIRMADOS aparece en el mensaje del usuario, ignóralo — ya lo tienes.
3. Tu respuesta SIEMPRE termina con UNA pregunta. Nunca cierres sin preguntar.
4. Confirma el dato recibido en media línea + pregunta inmediata. Ej:
   "Perfecto, monchox@gmail.com. ¿Cuál es tu número de teléfono?"
5. Máximo 2 líneas. Tono amigable y profesional.

${techLimitRule}`;
}

// ============================================================
// EMAIL DE LEAD — HTML con datos + transcripción
// ============================================================
async function sendLeadEmail(data, tipo, history) {
  const nombre    = data.nombre    || "Sin nombre";
  const telefono  = data.telefono  || "—";
  const ubicacion = data.ubicacion || "—";
  const proyecto  = data.proyecto  || "—";
  const capacidad = data.capacidad || "—";
  const tension   = data.tension   || "—";
  const fecha     = data.fecha     || "—";

  tipo = tipo || "sin clasificar";
  const subject = `🔌 Lead ${tipo.toUpperCase()} — ${nombre} | QUATRIC`;

  const filasDatos = [
    ["Tipo",       tipo],
    ["Nombre",     nombre],
    ["Teléfono",   telefono],
    ["Correo",     data.correo || "—"],
    ["Ubicación",  ubicacion],
    ["Proyecto",   proyecto],
    tipo === "industrial" && ["Capacidad",  capacidad],
    tipo === "industrial" && ["Tensión",    tension],
    tipo === "industrial" && ["Fecha est.", fecha],
  ]
    .filter(Boolean)
    .map(([k, v]) => `<tr><td style="padding:6px 12px;font-weight:600;background:#f4f4f4;border:1px solid #ddd">${k}</td><td style="padding:6px 12px;border:1px solid #ddd">${v}</td></tr>`)
    .join("");

  const transcripcion = history
    .filter(m => m.role !== "system")
    .map(m => {
      const quien  = m.role === "user" ? "👤 Cliente" : "🤖 QUATRIC Bot";
      const color  = m.role === "user" ? "#1a1a2e"    : "#444";
      const bgColor= m.role === "user" ? "#eef2ff"    : "#f9f9f9";
      return `<tr style="background:${bgColor}"><td style="padding:5px 12px;font-weight:600;color:${color};border:1px solid #eee;white-space:nowrap">${quien}</td><td style="padding:5px 12px;border:1px solid #eee">${m.content}</td></tr>`;
    })
    .join("");

  const html = `
<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;color:#222;max-width:680px;margin:auto">
  <h2 style="background:#1a1a2e;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;margin:0">
    🔌 Nuevo Lead ${tipo.charAt(0).toUpperCase()+tipo.slice(1)} — QUATRIC SV
  </h2>
  <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">
    <h3 style="margin-top:0">Datos del cliente</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${filasDatos}</table>
    <h3 style="margin-top:24px">Transcripción de la conversación</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">${transcripcion}</table>
    <p style="font-size:11px;color:#999;margin-top:20px">Generado automáticamente por QUATRIC Chatbot</p>
  </div>
</body></html>`;

  await transporter.sendMail({
    from:    process.env.EMAIL_USER,
    to:      process.env.LEAD_EMAIL || "proyectos@quatricsv.com",
    subject,
    html,
  });
}

function saveLeadToFile(data) {
  const filePath = "./leads.json";

  let leads = [];

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    leads = JSON.parse(content || "[]");
  }

  leads.push({
    ...data,
    fecha_guardado: new Date().toISOString()
  });

  fs.writeFileSync(filePath, JSON.stringify(leads, null, 2));
}


// ============================================================
// EMAIL DE CONFIRMACIÓN AL CLIENTE
// ============================================================
async function sendConfirmationEmail(data) {
    if (!data.correo || !data.correo.includes("@")) {
    console.log("⚠️ Correo inválido, no se envía confirmación:", data.correo);
    return;
  }

  const nombre    = data.nombre    || "Cliente";
  const tipo      = data.tipo      || "general";
  const proyecto  = data.proyecto  || "—";
  const ubicacion = data.ubicacion || "—";
  const telefono  = data.telefono  || "—";
  const capacidad = data.capacidad || null;
  const tension   = data.tension   || null;

  const filas = [
    ["Nombre",    nombre],
    ["Teléfono",  telefono],
    ["Correo",    data.correo],
    ["Proyecto",  proyecto],
    ["Ubicación", ubicacion],
    capacidad && ["Capacidad", capacidad],
    tension   && ["Tensión",   tension],
  ]
    .filter(Boolean)
    .map(([k, v]) => `
      <tr>
        <td style="padding:8px 16px;font-weight:600;background:#f4f6ff;border:1px solid #dde3f0;width:130px">${k}</td>
        <td style="padding:8px 16px;border:1px solid #dde3f0">${v}</td>
      </tr>`
    ).join("");



  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f0f2f8;font-family:system-ui,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f8;padding:40px 0">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08)">

        <!-- Header -->
        <tr>
          <td style="background:#1a1a2e;padding:28px 32px">
            <p style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:0.5px">⚡ QUATRIC SV</p>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.65);font-size:13px">Ingeniería Eléctrica · El Salvador</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px">
            <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#1a1a2e">¡Hola, ${nombre}! 👋</p>
            <p style="margin:0 0 24px;color:#444;font-size:15px;line-height:1.6">
              Hemos recibido tu solicitud correctamente. Un representante de QUATRIC
              se pondrá en contacto contigo a la brevedad para coordinar los detalles
              de tu proyecto.
            </p>

            <p style="margin:0 0 12px;font-weight:600;color:#1a1a2e;font-size:14px;text-transform:uppercase;letter-spacing:0.5px">Resumen de tu solicitud</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;margin-bottom:28px">
              ${filas}
            </table>

            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;margin-bottom:24px">
              <p style="margin:0;color:#166534;font-size:14px;line-height:1.6">
                ✅ <strong>Tu información ya está en manos de nuestro equipo.</strong><br/>
                Te contactaremos pronto al número <strong>${telefono}</strong> o a este correo.
              </p>
            </div>

            <p style="margin:0;color:#666;font-size:13px;line-height:1.6">
              Si tienes alguna consulta urgente, puedes escribirnos directamente a
              <a href="mailto:proyectos@quatricsv.com" style="color:#1a1a2e;font-weight:600">proyectos@quatricsv.com</a>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f4f6ff;padding:18px 32px;border-top:1px solid #e8ecf5">
            <p style="margin:0;color:#999;font-size:12px;text-align:center">
              © QUATRIC SV · Ingeniería Eléctrica · El Salvador<br/>
              Este correo fue generado automáticamente por nuestro asistente virtual.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from:    `"QUATRIC SV" <${process.env.EMAIL_USER}>`,
    to:      data.correo,
    replyTo: process.env.LEAD_EMAIL || "proyectos@quatricsv.com",
    subject: `✅ Recibimos tu solicitud, ${nombre} — QUATRIC SV`,
    html,
  });
}

// ============================================================
// RATE LIMITING — simple in-memory por IP
// ============================================================
const rateStore = new Map();
const RATE_WINDOW_MS = 60_000;  // 1 minuto
const RATE_MAX_HITS  = 25;      // máx 25 mensajes por minuto por IP

function isRateLimited(ip) {
  const now  = Date.now();
  const hits = (rateStore.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateStore.set(ip, hits);
  return hits.length > RATE_MAX_HITS;
}

// ============================================================
// ROUTES
// ============================================================

// ── POST /chat ────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  // Rate limit
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Demasiadas solicitudes. Espera un momento." });
  }

  // Validación básica
  const { message, sessionId } = req.body;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId requerido" });
  }
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Mensaje vacío" });
  }

  const trimmed = message.trim().slice(0, 600); // cap de seguridad

  // Sesión
  const session = getSession(sessionId);

  // Extracción de datos con regex (gratis — sin tokens)
  extractData(trimmed, session);

  // Detectar pregunta técnica y actualizar contador
  const TECH_RE = /\b(caida|ca[íi]da|voltaje|tension|tensi[óo]n|amper|kva|kw|calibe|cable|awg|watts?|resistencia|circuito|c[áa]lculo|dimensionar|norma|nema|nfpa|acometida|carga|fuerza|potencia|factor|cos|transformador|cortocircuito|protec|breaker|interruptor|tierra|neutro|fase|trifasico|bifasico)\b/i;
  const isTechQuestion = TECH_RE.test(trimmed) && trimmed.includes("?");
  if (isTechQuestion && session.techQuestions < 2) {
    session.techQuestions += 1;
  }

  // Prompt dinámico y mínimo
  const systemPrompt = buildDynamicPrompt(session.data, session.techQuestions);

  // Historial: solo últimas 10 interacciones para eficiencia
  const messages = [
    { role: "system", content: systemPrompt },
    ...session.history.slice(-10),
    { role: "user", content: trimmed },
  ];

  try {
    // ── Llamada a OpenAI (Responses API — requerida por gpt-5.4-mini) ────
    const response = await openai.responses.create({
      model:             "gpt-5.4-mini",
      max_output_tokens: 150,
      temperature:       0.35,
      input:             messages,   // [{role, content}, ...] — mismo formato
    });

    // Responses API devuelve output_text directo o anidado en output[]
    const reply = (
      response.output_text ??
      response.output
        ?.find(b => b.type === "message")
        ?.content?.find(c => c.type === "output_text")?.text ??
      response.output?.[0]?.content?.[0]?.text ??
      ""
    ).trim();

    if (!reply) throw new Error("Respuesta vacía — revisa API key y créditos");

    // Guardar en historial
    session.history.push({ role: "user",      content: trimmed });
    session.history.push({ role: "assistant", content: reply   });

    // ── Disparar email si lead está completo ────────────────
    let leadJustSent = false;
     
     if (!session.leadSent && isLeadComplete(session.data)) {
  session.leadSent = true;
  leadJustSent = true;

  console.log("📦 Lead completo detectado:", session.data);

  try {
    console.log("📧 Enviando a QUATRIC...");
    await sendLeadEmail(session.data, session.data.tipo, session.history);
    console.log("✅ Email QUATRIC enviado");

    console.log("📧 Enviando al cliente:", session.data.correo);
    await sendConfirmationEmail(session.data);
    console.log("✅ Email cliente enviado");

 saveLeadToFile(session.data);

  } catch (err) {
    console.error("❌ ERROR EN ENVÍO DE EMAIL:", err.message);
  }
}

    res.json({
      reply,
      meta: {
        tipo:          session.data.tipo,
        leadSent:      session.leadSent,
        leadJustSent,  // true solo en el request que disparó el email
        collected: Object.fromEntries(
          Object.entries(session.data).filter(([, v]) => v !== null)
        ),
      },
    });

  } catch (err) {
    console.error("[QUATRIC] Chat error:", err.message);
    res.status(500).json({ error: "Error al procesar. Intenta de nuevo." });
  }
});

// ── GET /health ───────────────────────────────────────────────
app.get("/health", (_, res) => {
  res.json({
    status:   "ok",
    sessions: sessions.size,
    uptime:   Math.floor(process.uptime()) + "s",
  });
});

// ── GET /test-email ───────────────────────────────────────────
app.get("/test-email", async (_, res) => {
  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_USER,
      to:      process.env.LEAD_EMAIL || "proyectos@quatricsv.com",
      subject: "✅ Test chatbot QUATRIC",
      html:    "<p>Email funcionando correctamente desde el chatbot de QUATRIC.</p>",
    });
    res.json({ status: "ok", message: "Correo enviado correctamente" });
  } catch (err) {
    console.error("[QUATRIC] Test email error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 QUATRIC Chat Server → http://localhost:${PORT}`);
});
