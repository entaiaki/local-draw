export const siteConfig = {
  name: 'SVAF',
  siteName: '二叉树树',
  title: '《二叉树树》官方网站',
  subtitle: 'AcoFork',
  url: 'https://2x.nz',
  icon: 'https://q2.qlogo.cn/headimg_dl?dst_uin=2726730791&spec=0',
  description: '《二叉树树》是一个专注于IT/互联网技术分享与实践的个人技术博客，在这里你可以找到众多前沿技术的分享与实践经验。',
  keywords: ['二叉树树','二叉树树官网','树','二叉树','二叉','博客','AcoFork Blog','AcoFork','Blog','acofork blog','acofork','blog'],
  lang: 'zh_CN',
  ogImage: '/files/img/official.png',
  author: {
    name: 'AcoFork',
    url: 'https://2x.nz'
  },
  bio: {
    avatar: 'https://q2.qlogo.cn/headimg_dl?dst_uin=2726730791&spec=0',
    name: '二叉树树',
    bio: 'Protect What You Love.',
    links: [
      {
        name: '爱发电',
        icon: 'simple-icons:afdian',
        url: 'https://www.ifdian.net/a/acofork',
        color: '#946ce6'
      },
      {
        name: 'B站主页',
        icon: 'simple-icons:bilibili',
        url: 'https://space.bilibili.com/325903362',
        color: '#fb7299'
      },
      {
        name: 'QQ群',
        icon: '/icon/QQ.svg',
        url: 'https://qm.qq.com/q/FWqOHlwL2m'
      },
      {
        name: 'Telegram群',
        icon: 'simple-icons:telegram',
        url: 'https://t.me/+_07DERp7k1ljYTc1',
        color: '#0088cc'
      },
      {
        name: 'GitHub',
        icon: 'mdi:github',
        url: 'https://github.com/afoim',
        color: ''
      },
      {
        name: 'Folo',
        icon: 'simple-icons:folo',
        url: 'https://app.folo.is/share/feeds/245004133358075904',
        color: '#ff6b35'
      }
    ]
  },
  live: {
    statusApi: 'https://b-live.2x.nz',
    roomUrl: 'https://live.bilibili.com/12005649'
  },
  services: {
    aiDraw: 'https://ai.2x.nz',
    gallery: 'https://p.2x.nz',
    fileExplorer: 'https://e3.2x.nz/api/',
    nat: 'https://nat.2x.nz/api/analyze',
    statsShare: 'https://umami.2x.nz/share/CdkXbGgZr6ECKOyK',
    longDomain: 'https://iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii.iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii.in',
    pageViews: 'https://t.2x.nz/batch'
  },
  analytics: {
    umami: { src: 'https://umami.2x.nz/script.js', websiteId: '5d710dbd-3a2e-43e3-a553-97b415090c63' },
    cfWebAnalytics: { token: '15fe148e91b34f10a15652e1a74ab26c' },
    cfUmami: { src: 'https://t.2x.nz/tracker.js' },
    baidu: { id: 'a87028bb5a1ed77d98f192bc12b56142' },
    google: { measurementId: 'G-RBZVQJCV26' },
    clarity: { projectId: 'v94yrasi99' }
  },
  giscus: {
    repo: 'afoim/giscus-fuwari',
    repoId: 'R_kgDOOi8quw',
    category: 'Announcements',
    categoryId: 'DIC_kwDOOi8qu84CprDV'
  },
  repos: {
    frontend: 'https://github.com/afoim/svaf',
    backend: 'https://github.com/afoim/acofork_forum_backend',
    natTool: 'https://github.com/afoim/webrtc_check_nat'
  },
  forum: {
    totpIssuer: 'AcoFork Forum'
  },
  links: {
    github: 'https://github.com/afoim/svaf'
  },
  navLinks: [
    { label: '博客', icon: 'mdi:post-outline', href: '/posts' },
    { label: '论坛', icon: 'mdi:forum', href: '/forum' },
    { label: 'AI 生图', icon: 'mdi:palette', href: '/draw', highlight: true, badge: '新' },
    { label: '课程表', icon: 'mdi:calendar-month', href: '/timetable' },
    { label: '封面制作', icon: 'mdi:image-edit', href: '/cover' },
    { label: '画廊', icon: 'mdi:image-multiple', href: '/gallery' },
    { label: '隐藏图', icon: 'mdi:layers-triple', href: '/ptg' },
    { label: '水印', icon: 'mdi:water', href: '/watermark' },
    { label: '图片转换', icon: 'mdi:swap-horizontal-bold', href: '/convert' },
    { label: '文件', icon: 'mdi:folder-open', href: '/files' },
    { label: '零宽短链', icon: 'mynaui:zero-circle-solid', href: '/short' },
    { label: '长链', icon: 'mdi:link-variant-plus', href: '/long' },
    { label: 'NAT 检测', icon: 'mdi:lan-check', href: '/nat' },
    { label: '友链', icon: 'mdi:link-variant', href: '/friends' },
    { label: '赞助', icon: 'mdi:heart', href: '/sponsors' },
    { label: '统计', icon: 'mdi:chart-line', href: 'https://umami.2x.nz/share/CdkXbGgZr6ECKOyK' }
  ] as const
};

export type SiteConfig = typeof siteConfig;
