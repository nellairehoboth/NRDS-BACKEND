const express = require('express');
const router = express.Router();
const axios = require('axios');
const { protect } = require('../middleware/auth');

// Helper for axios with retry
const axiosRetry = async (url, options, retries = 2) => {
    try {
        return await axios.get(url, options);
    } catch (err) {
        if (retries > 0 && (err.response?.status === 503 || !err.response)) {
            console.warn(`Retrying request to ${url} due to ${err.response?.status || 'network error'}. Retries left: ${retries - 1}`);
            await new Promise(res => setTimeout(res, 1000));
            return axiosRetry(url, options, retries - 1);
        }
        throw err;
    }
};

// @desc    Find coordinates from search query
// @route   GET /api/maps/search
router.get('/search', protect, async (req, res) => {
    try {
        const { q, limit = 5 } = req.query;
        if (!q) return res.status(400).json({ message: 'Search query is required' });

        const response = await axiosRetry('https://nominatim.openstreetmap.org/search', {
            params: {
                format: 'json',
                q: q,
                limit: limit,
                addressdetails: 1
            },
            headers: {
                'User-Agent': 'NellaiRehoboth-DepartmentStore-App/1.1 (Contact: help@nellairehoboth.com; Website: nellairehoboth.com)'
            },
            timeout: 8000
        });

        res.json(response.data);
    } catch (error) {
        console.error('Nominatim search proxy error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            message: 'Failed to fetch from Nominatim',
            details: error.response?.data || error.message
        });
    }
});

// @desc    Find address from coordinates (Reverse Geocoding)
// @route   GET /api/maps/reverse
router.get('/reverse', protect, async (req, res) => {
    try {
        const { lat, lon } = req.query;
        if (!lat || !lon) return res.status(400).json({ message: 'Coordinates are required' });

        const response = await axiosRetry('https://nominatim.openstreetmap.org/reverse', {
            params: {
                format: 'json',
                lat: lat,
                lon: lon,
                addressdetails: 1
            },
            headers: {
                'User-Agent': 'NellaiRehoboth-DepartmentStore-App/1.1 (Contact: help@nellairehoboth.com; Website: nellairehoboth.com)'
            },
            timeout: 8000
        });

        res.json(response.data);
    } catch (error) {
        console.error('Nominatim reverse proxy error:', error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            message: 'Failed to fetch from Nominatim',
            details: error.response?.data || error.message
        });
    }
});

// @desc    Get routing data from OSRM
// @route   GET /api/maps/route
router.get('/route', protect, async (req, res) => {
    try {
        const { start, end } = req.query;
        if (!start || !end) return res.status(400).json({ message: 'Start and end coordinates are required (lng,lat)' });

        const url = `https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson`;

        // Don't retry on rate limit errors - just fail fast
        const response = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'NellaiRehoboth-DepartmentStore-App/1.1 (Contact: help@nellairehoboth.com)',
                'Referer': 'https://nellairehoboth.com'
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error('OSRM route proxy error:', error.response?.data || error.message);

        // Check if it's a rate limit error
        if (error.response?.status === 429 || (error.response?.data && typeof error.response.data === 'string' && error.response.data.includes('Bandwidth limit'))) {
            return res.status(429).json({
                message: 'Rate limit exceeded. Please wait a moment and try again.',
                details: 'OSRM service temporarily unavailable due to rate limiting'
            });
        }

        res.status(error.response?.status || 500).json({
            message: 'Failed to fetch from OSRM',
            details: error.response?.data || error.message
        });
    }
});

module.exports = router;
