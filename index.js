import express from 'express'
import bodyParser from 'body-parser'
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode'
import cors from 'cors'

const app = express()
app.use(bodyParser.json())

const allowedOrigins = [
    'http://localhost:8080',
    'http://localhost:3000',
    'https://dev.senhadigitalplus.com.br',
    'https://app.senhadigitalplus.com.br',
    'https://dev.sdcrm.com.br',
    'https://app.sdcrm.com.br',
]

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true)
        } else {
            callback(new Error('Origem não permitida pelo CORS'))
        }
    },
    credentials: true
}))

const sessions = new Map()

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        console.log(`Sessão ${sessionId} já está rodando`)
        return sessions.get(sessionId)
    }

    const { state, saveCreds } = await useMultiFileAuthState(`auth_info/${sessionId}`)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
    })

    const sessionData = { sock, saveCreds, latestQR: null }
    sessions.set(sessionId, sessionData)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            sessionData.latestQR = await qrcode.toDataURL(qr)
            console.log(`QR code gerado para sessão ${sessionId}`)
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error).output.statusCode
            console.log(`Conexão da sessão ${sessionId} fechada, código:`, statusCode)

            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`Tentando reconectar sessão ${sessionId}...`)
                sessions.delete(sessionId)
                await startSession(sessionId)
            } else {
                console.log(`Logout detectado na sessão ${sessionId}, desconectando...`)
                sessions.delete(sessionId)
            }
        }

        if (connection === 'open') {
            console.log(`Sessão ${sessionId} conectada!`)
            sessionData.latestQR = null
        }
    })

    sock.ev.on('creds.update', saveCreds)

    return sessionData
}

app.get('/start/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId
    try {
        await startSession(sessionId)
        res.json({ session: `${sessionId}` })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get('/qrcode/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId
    const session = sessions.get(sessionId)

    if (!session || !session.latestQR) {
        return res.status(400).json({ error: 'QR Code ainda não gerado ou já conectado' })
    }

    res.json({ qr: session.latestQR })
})

async function sendMessageToNumber(sessionId, number, message) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error('Sessão não conectada')
    const jid = number + '@s.whatsapp.net'
    await session.sock.sendMessage(jid, { text: message })
}

app.post('/send-message/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId
    const { number, message } = req.body

    if (!number || !message) {
        return res.status(400).json({ error: 'number e message são obrigatórios' })
    }

    try {
        await sendMessageToNumber(sessionId, number, message)
        res.json({ message: `Mensagem enviada para ${number} pela sessão ${sessionId}` })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

async function disconnectSession(sessionId) {
    const session = sessions.get(sessionId)
    if (session) {
        await session.sock.logout()
        session.sock.ws.close()
        sessions.delete(sessionId)
    }
}

app.get('/status/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId
    const session = sessions.get(sessionId)

    if (!session) {
        return res.status(404).json({ connected: false, error: 'Sessão não iniciada ou desconectada' })
    }

    const isConnected = session.latestQR === null

    res.json({
        connected: isConnected,
        qr: session.latestQR || null,
        sessionId
    })
})

app.post('/disconnect/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId

    try {
        await disconnectSession(sessionId)
        res.json({ message: `Sessão ${sessionId} desconectada` })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

async function disconnectAllSessions() {
    for (const [sessionId, session] of sessions.entries()) {
        try {
            await session.sock.logout()
            session.sock.ws.close()
            sessions.delete(sessionId)
            console.log(`Sessão ${sessionId} desconectada`)
        } catch (err) {
            console.error(`Erro ao desconectar sessão ${sessionId}:`, err.message)
        }
    }
}

app.post('/disconnect-all', async (req, res) => {
    try {
        await disconnectAllSessions()
        res.json({ message: 'Todas as sessões foram desconectadas com sucesso' })
    } catch (err) {
        res.status(500).json({ error: 'Erro ao desconectar todas as sessões', details: err.message })
    }
})

const PORT = process.env.PORT || 3333
app.listen(PORT, () => {
    console.log(`API rodando em http://localhost:${PORT}`)
})
