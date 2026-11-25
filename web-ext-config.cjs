// Packaging rules for web-ext (Firefox signing/build). The xpi must ship
// only the runtime files: tests, docs and artifacts stay out.
module.exports = {
  ignoreFiles: [
    'web-ext-config.cjs',
    'updates.json',
    'test',
    'test/**',
    'web-ext-artifacts/**',
    '*.zip',
    '.gitignore',
    '*.md'
  ]
};
