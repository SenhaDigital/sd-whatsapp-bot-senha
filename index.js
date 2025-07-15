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

function normalizeBrazilianNumber(rawNumber) {
    // Remove tudo que não for dígito
    let number = rawNumber.replace(/\D/g, '')

    // Remove código do país se tiver (55)
    if (number.startsWith('55')) {
        number = number.slice(2)
    }

    // Agora number tem só DDD + número (sem 55)
    // Deve ter 10 ou 11 dígitos: 2 dígitos DDD + 8 ou 9 dígitos número

    if (number.length < 10 || number.length > 11) {
        throw new Error('Número inválido: deve conter DDD e número com 8 ou 9 dígitos')
    }

    const ddd = number.slice(0, 2)
    let phoneNumber = number.slice(2)

    // Remove nono dígito duplicado (se número tem 11 dígitos e o número começar com 99)
    if (phoneNumber.length === 9) {
        if (phoneNumber.startsWith('99')) {
            // Remove o primeiro 9 duplicado
            phoneNumber = phoneNumber.slice(1)
        }
    }

    // Se telefone tem 8 dígitos (fixo), adiciona o 9 na frente (assumindo que queremos celular)
    if (phoneNumber.length === 8) {
        phoneNumber = '9' + phoneNumber
    }

    // Agora phoneNumber tem 9 dígitos com nono dígito correto

    return '55' + ddd + phoneNumber
}

async function sendMessageToNumber(sessionId, rawNumber, message) {
    const session = sessions.get(sessionId)
    if (!session) throw new Error('Sessão não conectada')

    const normalizedNumber = normalizeBrazilianNumber(rawNumber)
    const jid = normalizedNumber + '@s.whatsapp.net'

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
