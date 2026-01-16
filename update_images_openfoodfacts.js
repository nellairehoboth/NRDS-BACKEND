require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Product = require('./models/Product');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/NRDS';

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
    .then(() => {
        console.log('MongoDB connected');
        startUpdate();
    })
    .catch(err => {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    });

async function startUpdate() {
    try {
        const products = await Product.find({ barcode: { $ne: null, $ne: '' } });

        console.log(`Found ${products.length} products with barcodes.`);

        let updatedCount = 0;
        let notFoundCount = 0;
        let errorCount = 0;
        let skippedCount = 0;

        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            const barcode = product.barcode;

            if (i % 50 === 0) {
                console.log(`Processing item ${i + 1}/${products.length}...`);
            }

            try {
                // Rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));

                const response = await axios.get(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, {
                    timeout: 5000
                });

                if (response.data && response.data.status === 1) {
                    const offProduct = response.data.product;
                    const imageUrl = offProduct.image_front_url;

                    if (imageUrl) {
                        // Update only image fields to avoid validation errors on other fields
                        await Product.updateOne(
                            { _id: product._id },
                            {
                                $set: { image: imageUrl },
                                $addToSet: { images: imageUrl }
                            }
                        );
                        console.log(`[UPDATED] ${product.name} (${barcode})`);
                        updatedCount++;
                    } else {
                        skippedCount++;
                    }
                } else {
                    notFoundCount++;
                }
            } catch (error) {
                console.error(`[ERROR] ${product.name} (${barcode}):`, error.message);
                errorCount++;
            }
        }

        console.log('--------------------------------------------------');
        console.log('Update Complete.');
        console.log(`Total Products Processed: ${products.length}`);
        console.log(`Updated: ${updatedCount}`);
        console.log(`Skipped (No Image): ${skippedCount}`);
        console.log(`Not Found in OpenFoodFacts: ${notFoundCount}`);
        console.log(`Errors: ${errorCount}`);

        process.exit(0);

    } catch (error) {
        console.error('Fatal error during update:', error);
        process.exit(1);
    }
}
