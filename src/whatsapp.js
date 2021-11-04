const fs = require('fs'),
path = require('path'),
qrcode = require('qrcode'),
clone = require('lodash.clonedeep'),
{ WAConnection } = require('@adiwajshing/baileys')

let sessions = [],
connections = {}

const getChats = (session, type) => {
    let chats = clone(
        session.chats.filter((item => type == 'group' ? item.jid.includes('@g.us') : item.jid.includes('@s.whatsapp.net'))).all()
    )

    return chats.map(chat => {
        if('messages' in chat) delete chat['messages']

        return chat
    })
}

const createExistedSession = async session => {
    let wa = new WAConnection()

	wa.version = [3, 3234, 9]
    wa.browserDescription = ['Windows', 'Chrome', '10']
    wa.loadAuthInfo(path.join(__dirname, 'sessions', `${session}.json`))

    wa.on('open', () => {
        const authInfo = wa.base64EncodedAuthInfo()
        fs.writeFileSync(path.join(__dirname, 'sessions', `${session}.json`), JSON.stringify(authInfo, null, '\t'))

        sessions.push(session)
        connections[session] = wa
    })

    wa.on('qr', () => deleteSession(session))
    wa.on('close', () => deleteSession(session))

    await wa.connect()
    .catch(err => console.log('Unexpected error: ' + err))
}

const createSession = async (socket, session) => {
    let wa = new WAConnection()

	wa.version = [3, 3234, 9]
    wa.browserDescription = ['Windows', 'Chrome', '10']

    let timeout = setTimeout(() => {
        wa.close()
    }, 60000)

    wa.on('qr', qr => {
        qrcode.toDataURL(qr, (err, url) => {
            if(err) socket.emit('message', 'An error occured during creating QR image.')

            socket.emit('qr', {id: session, qr: url})
        })
    })

    wa.on('open', () => {
        const authInfo = wa.base64EncodedAuthInfo()
        fs.writeFileSync(path.join(__dirname, 'sessions', `${session}.json`), JSON.stringify(authInfo, null, '\t'))

        sessions.push(session)
        connections[session] = wa

        clearTimeout(timeout)

        socket.emit('added', session)
    })

    wa.on('close', () => {
        deleteSession(session)

        socket.emit('deleted', session)
    })
    
    return await wa.connect()
}

const deleteSession = session => {
    if(fs.existsSync(path.join(__dirname, 'sessions', `${session}.json`))) fs.unlinkSync(path.join(__dirname, 'sessions', `${session}.json`))

    delete connections[session]

    if(checkSession(session)){
        let index = sessions.indexOf(session)
        sessions.splice(index, 1)
    }
}

const checkSession = session => {
    let index = sessions.indexOf(session)

    return index !== -1
}

const getActiveSessions = () => {
    return sessions
}

const  getSession = session => {
    if(session in connections) return connections[session]

    return false
}

const formatPhone = phone => {
    let formatted = phone.replace(/\D/g, '')

    return formatted += '@s.whatsapp.net'
}

const formatGroup = group => {
    let formatted = group.replace(/[^\d\-]/g, '')

    return formatted += '@g.us'
}

const init = () => {
    fs.readdir(path.join(__dirname, 'sessions'), (err, files) => {
        if(err) throw err

        files.forEach(file => {
            if(file.indexOf('.json') !== -1) createExistedSession(file.replace('.json', ''))
        })
    })
}

module.exports = {
    init: init,
    formatPhone: formatPhone,
    formatGroup: formatGroup,
    getSession: getSession,
    getActiveSessions: getActiveSessions,
    checkSession: checkSession,
    createSession: createSession,
    deleteSession: deleteSession,
    getChats: getChats
}