import { each } from 'lodash'
import webpack from 'webpack'
import VueSSRClientPlugin from 'vue-server-renderer/client-plugin'
import HTMLPlugin from 'html-webpack-plugin'
import FriendlyErrorsWebpackPlugin from 'friendly-errors-webpack-plugin'
import UglifyJSPlugin from 'uglifyjs-webpack-plugin'
import ProgressBarPlugin from 'progress-bar-webpack-plugin'
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer'
import { resolve } from 'path'
import { existsSync } from 'fs'
import Debug from 'debug'
import base from './base.config.js'

const debug = Debug('nuxt:build')
debug.color = 2 // Force green color

/*
|--------------------------------------------------------------------------
| Webpack Client Config
|
| Generate public/dist/client-vendor-bundle.js
| Generate public/dist/client-bundle.js
|
| In production, will generate public/dist/style.css
|--------------------------------------------------------------------------
*/
export default function webpackClientConfig() {
  let config = base.call(this, 'client')

  // Entry points
  config.entry.app = resolve(this.options.buildDir, 'client.js')
  config.entry.vendor = this.vendor()

  // Add CommonChunks plugin
  commonChunksPlugin.call(this, config)

  // Env object defined in nuxt.config.js
  let env = {}
  each(this.options.env, (value, key) => {
    env['process.env.' + key] = (['boolean', 'number'].indexOf(typeof value) !== -1 ? value : JSON.stringify(value))
  })

  // Generate output HTML for SPA
  config.plugins.push(
    new HTMLPlugin({
      filename: 'index.spa.html',
      template: this.options.appTemplatePath,
      inject: true,
      chunksSortMode: 'dependency'
    })
  )

  // Generate output HTML for SSR
  if (this.options.build.ssr) {
    config.plugins.push(
      new HTMLPlugin({
        filename: 'index.ssr.html',
        template: this.options.appTemplatePath,
        inject: false // Resources will be injected using bundleRenderer
      })
    )
  }

  // Generate vue-ssr-client-manifest
  config.plugins.push(
    new VueSSRClientPlugin({
      filename: 'vue-ssr-client-manifest.json'
    })
  )

  // Extract webpack runtime & manifest
  config.plugins.push(
    new webpack.optimize.CommonsChunkPlugin({
      name: 'manifest',
      minChunks: Infinity,
      filename: this.options.build.filenames.manifest
    })
  )

  // Define Env
  config.plugins.push(
    new webpack.DefinePlugin(Object.assign(env, {
      'process.env.NODE_ENV': JSON.stringify(env.NODE_ENV || (this.options.dev ? 'development' : 'production')),
      'process.env.VUE_ENV': JSON.stringify('client'),
      'process.mode': JSON.stringify(this.options.mode),
      'process.browser': true,
      'process.client': true,
      'process.server': false,
      'process.static': this.isStatic
    }))
  )

  // Build progress bar
  config.plugins.push(
    new ProgressBarPlugin()
  )

  // --------------------------------------
  // Dev specific config
  // --------------------------------------
  if (this.options.dev) {
    // Add friendly error plugin
    config.plugins.push(new FriendlyErrorsWebpackPlugin())

    // https://webpack.js.org/plugins/named-modules-plugin
    config.plugins.push(new webpack.NamedModulesPlugin())

    // Add HMR support
    config.entry.app = [
      // https://github.com/glenjamin/webpack-hot-middleware#config
      `webpack-hot-middleware/client?name=client&reload=true&timeout=30000&path=${this.options.router.base}/__webpack_hmr`.replace(/\/\//g, '/'),
      config.entry.app
    ]
    config.plugins.push(
      new webpack.HotModuleReplacementPlugin(),
      new webpack.NoEmitOnErrorsPlugin()
    )

    // DllReferencePlugin
    if (this.options.build.dll) {
      dllPlugin.call(this, config)
    }
  }

  // --------------------------------------
  // Production specific config
  // --------------------------------------
  if (!this.options.dev) {
    // Scope Hoisting
    if (this.options.build.scopeHoisting === true) {
      config.plugins.push(new webpack.optimize.ModuleConcatenationPlugin())
    }

    // https://webpack.js.org/plugins/hashed-module-ids-plugin
    config.plugins.push(new webpack.HashedModuleIdsPlugin())

    // Minify JS
    // https://github.com/webpack-contrib/uglifyjs-webpack-plugin
    config.plugins.push(
      new UglifyJSPlugin({
        cache: true,
        sourceMap: true,
        extractComments: {
          filename: 'LICENSES'
        }
      })
    )

    // Webpack Bundle Analyzer
    if (this.options.build.analyze) {
      config.plugins.push(new BundleAnalyzerPlugin(Object.assign({}, this.options.build.analyze)))
    }
  }

  // Extend config
  if (typeof this.options.build.extend === 'function') {
    const isDev = this.options.dev
    const extendedConfig = this.options.build.extend.call(this, config, {
      get dev() {
        console.warn('dev has been deprecated in build.extend(), please use isDev') // eslint-disable-line no-console
        return isDev
      },
      isDev,
      isClient: true
    })
    // Only overwrite config when something is returned for backwards compatibility
    if (extendedConfig !== undefined) {
      config = extendedConfig
    }
  }

  return config
}

// --------------------------------------------------------------------------
// Adds Common Chunks Plugin
// --------------------------------------------------------------------------
function commonChunksPlugin(config) {
  const _this = this
  const totalPages = _this.routes ? _this.routes.length : 0

  // This well-known vendor may exist as a dependency of other requests.
  const maybeVendor = [
    '/core-js/',
    '/regenerator-runtime/',
    '/es6-promise/',
    '/babel-runtime/',
    '/lodash/'
  ]

  // Create explicit vendor chunk
  config.plugins.unshift(
    new webpack.optimize.CommonsChunkPlugin({
      name: 'vendor',
      filename: this.options.build.filenames.vendor,
      minChunks(module, count) {
        // Detect and externalize well-known vendor if detected
        if (module.context && maybeVendor.some(v => module.context.includes(v))) {
          return true
        }
        // A module is extracted into the vendor chunk when...
        return (
          // If it's inside node_modules
          /node_modules/.test(module.context) &&
          // Do not externalize if the request is a CSS file
          !/\.(css|less|scss|sass|styl|stylus)$/.test(module.request) &&
          // Used in at-least 1/2 of the total pages
          (totalPages <= 2 ? count >= totalPages : count >= totalPages * 0.5)
        )
      }
    })
  )
}

// --------------------------------------------------------------------------
// Adds DLL plugin
// https://github.com/webpack/webpack/tree/master/examples/dll-user
// --------------------------------------------------------------------------
function dllPlugin(config) {
  const _dlls = []
  const vendorEntries = this.vendorEntries()
  const dllDir = resolve(this.options.cacheDir, config.name + '-dll')
  Object.keys(vendorEntries).forEach(v => {
    const dllManifestFile = resolve(dllDir, v + '-manifest.json')
    if (existsSync(dllManifestFile)) {
      _dlls.push(v)
      config.plugins.push(
        new webpack.DllReferencePlugin({
          // context: this.options.rootDir,
          manifest: dllManifestFile // Using full path to allow finding .js dll file
        })
      )
    }
  })
  if (_dlls.length) {
    debug('Using dll for ' + _dlls.join(','))
  }
}
