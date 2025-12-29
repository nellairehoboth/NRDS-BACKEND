const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
    deliveryChargePerKm: {
        type: Number,
        default: 0
    },
    freeDistanceLimit: {
        type: Number,
        default: 5
    },
    maxDeliveryDistance: {
        type: Number,
        default: 20
    },
    freeDeliveryThreshold: {
        type: Number,
        default: 500
    },
    storeLatitude: {
        type: Number,
        default: 10.7870
    },
    storeLongitude: {
        type: Number,
        default: 79.1378
    },
    deliverySlabs: [{
        minDistance: Number,
        maxDistance: Number, // Use high number like 999 for "Above"
        charge: Number
    }],
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Setting', settingSchema);
