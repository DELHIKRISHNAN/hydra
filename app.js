const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const uuid = require('uuid');
const path = require('path');
const { CronJob } = require('cron');
const { DateTime } = require('luxon');

// Initialize Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json'); // Path to Firebase service account key
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Initialize Express
const app = express();

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'templates')));

// Helper functions
const generateApiKey = () => uuid.v4();

// Cron job to reset daily water usage
const resetDailyUsage = new CronJob('0 0 * * *', async () => {
    console.log('Resetting daily usage...');
    const usersSnapshot = await db.collection('users').where('is_admin', '==', false).get();
    const currentDate = DateTime.now().toISODate();

    usersSnapshot.forEach(async (userDoc) => {
        const user = userDoc.data();
        const waterUsage = user.water_usage || [];
        const usageHistory = user.usage_history || [];

        if (waterUsage.length > 0) {
            const lastEntry = waterUsage[waterUsage.length - 1];
            usageHistory.push(lastEntry);
        }

        await db.collection('users').doc(userDoc.id).update({
            water_usage: [{ date: currentDate, usage: 0 }],
            usage_history: usageHistory,
        });
    });
});
resetDailyUsage.start();

// Initialize admin user
(async () => {
    const adminSnapshot = await db.collection('users').where('username', '==', 'admin').get();
    if (adminSnapshot.empty) {
        const hashedPassword = await bcrypt.hash('admin123', 10);
        await db.collection('users').add({
            username: 'admin',
            password: hashedPassword,
            is_admin: true,
            water_usage: [{ date: DateTime.now().toISODate(), usage: 0 }],
            usage_history: [],
        });
        console.log('Admin user created.');
    }
})();

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'templates', 'register.html')));

// Login route
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const userSnapshot = await db.collection('users').where('username', '==', username).get();

    if (!userSnapshot.empty) {
        const userDoc = userSnapshot.docs[0];
        const user = userDoc.data();

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (isPasswordValid) {
            if (user.is_admin) {
                return res.redirect('/admin_dashboard');
            }
            return res.redirect(`/user_dashboard?username=${username}`);
        }
    }

    res.status(401).send('Invalid credentials! Please try again.');
});

// Register route
app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    const userSnapshot = await db.collection('users').where('username', '==', username).get();
    if (!userSnapshot.empty) {
        return res.status(400).send('Username already exists!');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const apiKey = generateApiKey();

    await db.collection('users').add({
        username,
        password: hashedPassword,
        api_key: apiKey,
        water_usage: [{ date: DateTime.now().toISODate(), usage: 0 }],
        usage_history: [],
    });

    res.redirect(`/user_dashboard?username=${username}`);
});

// Admin dashboard
app.get('/admin_dashboard', async (req, res) => {
    const usersSnapshot = await db.collection('users').get();
    const userData = [];

    usersSnapshot.forEach((userDoc) => {
        const user = userDoc.data();
        const latestUsage = user.water_usage ? user.water_usage.slice(-1)[0] : { date: 'N/A', usage: 0 };
        const apiKey = user.api_key || 'N/A';

        if (!user.is_admin) {
            userData.push({
                username: user.username,
                api_key: apiKey,
                latest_usage: latestUsage.usage,
            });
        }
    });

    res.render('admin_dashboard', { users: userData });
});

// User dashboard
app.get('/user_dashboard', async (req, res) => {
    const { username } = req.query;
    const userSnapshot = await db.collection('users').where('username', '==', username).get();

    if (!userSnapshot.empty) {
        const user = userSnapshot.docs[0].data();
        const latestUsage = user.water_usage ? user.water_usage.slice(-1)[0] : { date: 'N/A', usage: 0 };
        return res.render('user_dashboard', { user, latest_usage: latestUsage });
    }

    res.status(404).send('User not found!');
});

// Update water usage
app.get('/update_water_usage', async (req, res) => {
    const { apikey, new_usage } = req.query;

    if (!apikey || !new_usage) {
        return res.status(400).send('Invalid request. API key and new usage are required.');
    }

    const userSnapshot = await db.collection('users').where('api_key', '==', apikey).get();
    if (!userSnapshot.empty) {
        const userDoc = userSnapshot.docs[0];
        const user = userDoc.data();

        const currentDate = DateTime.now().toISODate();
        const waterUsage = user.water_usage || [];

        // Check if today's usage exists
        const todayEntry = waterUsage.find((entry) => entry.date === currentDate);

        if (todayEntry) {
            todayEntry.usage = parseInt(new_usage, 10);
        } else {
            waterUsage.push({ date: currentDate, usage: parseInt(new_usage, 10) });
        }

        await db.collection('users').doc(userDoc.id).update({
            water_usage: waterUsage,
        });

        return res.json({ message: 'Water usage updated successfully!' });
    }

    res.status(404).json({ error: 'User not found!' });
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
