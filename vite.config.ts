import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
    server: {
        port: 3000,
        open: true,
    },
    build: {
        target: 'esnext',
    },
    assetsInclude: ['**/*.wgsl'],
    optimizeDeps: {
        include: ['@kitware/vtk.js'],
    },
    // Vitest configuration
    test: {
        environment: 'jsdom',
        globals: true,
    },
});
