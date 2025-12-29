const express = require('express');
const router = express.Router();
const Setting = require('../models/Setting');
const { protect, admin } = require('../middleware/auth');

// Get settings - Public (for checkout)
router.get('/public', async (req, res) => {
    try {
        let settings = await Setting.findOne();
        if (!settings) {
            // Create default settings if none exist
            settings = await Setting.create({
                deliveryChargePerKm: 0,
                freeDeliveryThreshold: 500,
                maxDeliveryDistance: 20,
                storeLatitude: 10.7870,
                storeLongitude: 79.1378,
                deliverySlabs: [
                    { minDistance: 0, maxDistance: 3, charge: 30 },
                    { minDistance: 3, maxDistance: 6, charge: 50 },
                    { minDistance: 6, maxDistance: 10, charge: 80 },
                    { minDistance: 10, maxDistance: 999, charge: 120 }
                ]
            });
        }
        res.json({
            success: true,
            settings: {
                deliveryChargePerKm: settings.deliveryChargePerKm,
                freeDistanceLimit: settings.freeDistanceLimit,
                maxDeliveryDistance: settings.maxDeliveryDistance,
                freeDeliveryThreshold: settings.freeDeliveryThreshold,
                storeLatitude: settings.storeLatitude, storeLongitude: settings.storeLongitude, deliverySlabs: settings.deliverySlabs
            }
        });
    } catch (error) {
        console.error('Get public settings error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch settings' });
    }
});

// Get settings - Admin
router.get('/', protect, admin, async (req, res) => {
    try {
        let settings = await Setting.findOne();
        if (!settings) {
            settings = await Setting.create({
                deliveryChargePerKm: 0,
                freeDeliveryThreshold: 500,
                maxDeliveryDistance: 20,
                storeLatitude: 10.7870,
                storeLongitude: 79.1378,
                deliverySlabs: [
                    { minDistance: 0, maxDistance: 3, charge: 30 },
                    { minDistance: 3, maxDistance: 6, charge: 50 },
                    { minDistance: 6, maxDistance: 10, charge: 80 },
                    { minDistance: 10, maxDistance: 999, charge: 120 }
                ]
            });
        }
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Get admin settings error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch settings' });
    }
});

// Update settings - Admin
router.post('/update', protect, admin, async (req, res) => {
    try {
        const {
            deliveryChargePerKm,
            freeDistanceLimit,
            maxDeliveryDistance,
            freeDeliveryThreshold,
            storeLatitude,
            storeLongitude,
            deliverySlabs
        } = req.body;

        let settings = await Setting.findOne();
        if (settings) {
            settings.deliveryChargePerKm = req.body.deliveryChargePerKm;
            settings.freeDistanceLimit = req.body.freeDistanceLimit;
            settings.maxDeliveryDistance = req.body.maxDeliveryDistance;
            settings.freeDeliveryThreshold = req.body.freeDeliveryThreshold;
            settings.storeLatitude = req.body.storeLatitude;
            settings.storeLongitude = req.body.storeLongitude;
            settings.deliverySlabs = req.body.deliverySlabs;
            settings.updatedBy = req.user.userId;
            await settings.save();
        } else {
            settings = await Setting.create({
                deliveryChargePerKm,
                freeDistanceLimit,
                maxDeliveryDistance,
                freeDeliveryThreshold,
                storeLatitude,
                storeLongitude,
                deliverySlabs,
                updatedBy: req.user.userId
            });
        }

        res.json({ success: true, settings, message: 'Settings updated successfully' });
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ success: false, message: 'Failed to update settings' });
    }
});

module.exports = router;
