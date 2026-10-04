import { svelte } from '@sveltejs/vite-plugin-svelte'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // npm run dev      纯 HTTP，只监听 localhost，桌面自己用，不用处理证书
  // npm run dev:lan  HTTPS + 监听所有网卡，手机走局域网访问
  //
  // 局域网模式为什么必须 HTTPS：手机用 http://192.168.x.x 打开时不是「安全上下文」，
  // 浏览器会直接禁掉 navigator.mediaDevices，麦克风按钮点了没反应。
  const lan = mode === 'lan'

  // 部署到 GitHub Pages 时应用不在域名根目录，而在 https://<user>.github.io/<repo>/，
  // 所以资源前缀必须是 /<repo>/ 。CI 里通过 APP_BASE 注入；本地开发不设，保持 '/'。
  const base = process.env.APP_BASE ?? '/'

  return {
    base,
    plugins: [svelte(), ...(lan ? [basicSsl()] : [])],
    server: {
      // 监听 0.0.0.0，手机才能通过局域网 IP 连进来
      host: lan,
      // 手机用的域名/IP 不在 Vite 的 Host 白名单里，局域网模式下放开校验
      ...(lan ? { allowedHosts: true } : {}),
      watch: {
        // notation-perf/ 是独立的基准项目，不属于这个应用。
        // 而且编辑器/工具写文件是「临时文件 + 改名」，chokidar 会去 watch 那个
        // 转瞬即逝的临时目录，在 Windows 上抛 EBUSY 直接把 dev server 打挂 ——
        // 实测就是这么挂的，所以这里一并忽略掉。
        ignored: ['**/notation-perf/**', '**/*.tmpdir/**'],
      },
    },
  }
})
