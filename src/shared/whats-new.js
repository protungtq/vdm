'use strict';
/*
 * "What's new" texts shown in the window that opens after an update (and from Settings → About).
 * Newest first. Texts are English.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WHATS_NEW = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const ENTRIES = [
    {
      version: '0.2.5',
      date: '2026-11-16',
      items: [
        {
          icon: 'star',
          title: { en: 'The logo inside the app uses the new artwork', vi: 'Logo trong app dùng artwork mới' },
          text: {
            en: 'The title bars, dialogs and Settings now show the new red icon with the yellow swoosh and the Vietnamese flag badge, matching the app icon.', vi: 'Thanh tiêu đề, hộp thoại và Cài đặt giờ hiển thị icon đỏ mới với vệt vàng và huy hiệu cờ Việt Nam, khớp với icon của app.',
          },
        },
        {
          icon: 'tool',
          title: { en: 'Full-colour tray icon on Windows and Linux', vi: 'Icon khay hệ thống đủ màu trên Windows và Linux' },
          text: {
            en: 'The system tray now shows the red icon with the white download arrow, clearly visible on light and dark taskbars alike.', vi: 'Khay hệ thống giờ hiển thị icon đỏ với mũi tên tải trắng, nhìn rõ trên cả thanh tác vụ sáng lẫn tối.',
          },
        },
      ],
    },
    {
      version: '0.2.4',
      date: '2026-11-16',
      items: [
        {
          icon: 'tool',
          title: { en: 'Download video button: close it, and it stays out of the way', vi: 'Nút tải video: đóng lại là nó tránh ra' },
          text: {
            en: 'The button in the browser has a × to close it. It moves to another corner when it would cover a site’s own buttons, and you can turn it off for one website in the extension’s popup. Reload the VDM extension to get this.', vi: 'Nút trên trình duyệt có dấu × để đóng. Nó tự chuyển sang góc khác khi che nút của trang web, và bạn có thể tắt nó cho từng trang trong popup của tiện ích. Tải lại tiện ích VDM để có tính năng này.',
          },
        },
        {
          icon: 'star',
          title: { en: 'The extension stays in Edge and Chrome', vi: 'Tiện ích không bị mất khỏi Edge và Chrome' },
          text: {
            en: 'VDM now keeps its browser extension in a permanent folder, so the browser no longer forgets it after a restart (this affected the portable version). Settings → Browser integration → Open extension folder shows it. Load that folder in your browser once.', vi: 'VDM giờ giữ tiện ích trình duyệt trong một thư mục cố định, nên trình duyệt không quên nó sau khi khởi động lại nữa (lỗi này ảnh hưởng bản portable). Cài đặt → Tích hợp trình duyệt → Mở thư mục tiện ích sẽ cho bạn thấy nó. Chỉ cần tải thư mục đó trong trình duyệt một lần.',
          },
        },
        {
          icon: 'clock',
          title: { en: 'Update button fixed', vi: 'Đã sửa nút cập nhật' },
          text: {
            en: 'The Update Available button works again, and VDM waits for a new release’s files before offering it.', vi: 'Nút Có bản cập nhật hoạt động trở lại, và VDM đợi tới khi tệp của bản mới tải lên xong mới đề xuất cập nhật.',
          },
        },
      ],
    },
    {
      version: '0.2.2',
      date: '2026-11-14',
      items: [
        {
          icon: 'tool',
          title: { en: 'Update button fixed', vi: 'Đã sửa nút cập nhật' },
          text: {
            en: 'The Update Available button works again: it installs the new version itself instead of doing nothing. If an update is found while its files are still being uploaded, VDM waits for them.', vi: 'Nút Có bản cập nhật hoạt động trở lại: nó tự cài đặt phiên bản mới thay vì không làm gì. Nếu phát hiện bản cập nhật trong lúc tệp của nó vẫn đang tải lên, VDM sẽ đợi.',
          },
        },
      ],
    },
    {
      version: '0.2.1',
      date: '2026-11-14',
      items: [
        {
          icon: 'tool',
          title: { en: 'Download video: the right video', vi: 'Tải video: đúng video bạn cần' },
          text: {
            en: 'On pages with several videos, the browser button now downloads the video you clicked instead of another one. Reload the VDM extension in your browser to get this fix.', vi: 'Trên trang có nhiều video, nút trên trình duyệt giờ tải đúng video bạn đã nhấn thay vì video khác. Tải lại tiện ích VDM trong trình duyệt để có bản sửa này.',
          },
        },
        {
          icon: 'star',
          title: { en: 'A window when a download finishes', vi: 'Cửa sổ hiện khi tải xong' },
          text: {
            en: 'A separate “Download complete” window opens on top of everything, with Open and Open folder.', vi: 'Một cửa sổ “Tải xuống hoàn tất” riêng sẽ mở lên trên cùng, với nút Mở và Mở thư mục.',
          },
        },
        {
          icon: 'globe',
          title: { en: 'Update check fixed', vi: 'Đã sửa kiểm tra cập nhật' },
          text: {
            en: 'Update checks no longer fail with “GitHub responded 403” on shared networks and VPNs.', vi: 'Kiểm tra cập nhật không còn lỗi “GitHub trả về mã 403” trên mạng dùng chung và VPN nữa.',
          },
        },
      ],
    },
    {
      version: '0.2.0',
      date: '2026-11-13',
      items: [
        {
          icon: 'globe',
          title: { en: 'Proxy support', vi: 'Hỗ trợ proxy' },
          text: {
            en: 'Use an HTTP or SOCKS5 proxy, or the one from your system, with an optional login. It works for downloads, video downloads and update checks. Settings → Proxy.', vi: 'Dùng proxy HTTP hoặc SOCKS5, hoặc proxy của hệ thống, có thể kèm đăng nhập. Áp dụng cho lượt tải xuống, tải video và kiểm tra cập nhật. Cài đặt → Proxy.',
          },
        },
        {
          icon: 'clock',
          title: { en: '“Last try” column', vi: 'Cột “Lần thử cuối”' },
          text: {
            en: 'The compact list shows the date and time of each download’s last attempt, so you can see when something was tried or failed.', vi: 'Danh sách gọn hiển thị ngày giờ của lần thử cuối cho mỗi lượt tải, để bạn biết khi nào nó được thử hay thất bại.',
          },
        },
        {
          icon: 'list',
          title: { en: 'A cleaner list', vi: 'Danh sách gọn gàng hơn' },
          text: {
            en: 'The lines between downloads are gone, so the list looks calmer.', vi: 'Đã bỏ các đường kẻ giữa các lượt tải, danh sách trông nhẹ nhàng hơn.',
          },
        },
        {
          icon: 'star',
          title: { en: 'This window', vi: 'Cửa sổ này' },
          text: {
            en: 'After every update VDM now tells you what changed. You can open it again from Settings → About.', vi: 'Sau mỗi lần cập nhật, VDM giờ cho bạn biết những gì đã thay đổi. Bạn có thể mở lại từ Cài đặt → Giới thiệu.',
          },
        },
      ],
    },
    {
      version: '0.1.3',
      date: '2026-11-12',
      items: [
        {
          icon: 'shield',
          title: { en: 'Security update', vi: 'Cập nhật bảo mật' },
          text: {
            en: 'Browser cookies are encrypted, only VDM’s own extension can send downloads, and the video tools are verified before use.', vi: 'Cookie trình duyệt được mã hóa, chỉ tiện ích của chính VDM mới gửi được lượt tải, và các công cụ video được kiểm chứng trước khi dùng.',
          },
        },
      ],
    },
    {
      version: '0.1.2',
      date: '2026-11-12',
      items: [
        {
          icon: 'tool',
          title: { en: 'Fixed old browser downloads reopening', vi: 'Đã sửa lỗi mở lại các lượt tải cũ từ trình duyệt' },
          text: {
            en: 'Reopening the browser no longer opens windows for old downloads.', vi: 'Mở lại trình duyệt không còn hiện cửa sổ cho các lượt tải cũ nữa.',
          },
        },
      ],
    },
    {
      version: '0.1.1',
      date: '2026-11-12',
      items: [
        {
          icon: 'list',
          title: { en: 'Queues and multi-select', vi: 'Hàng chờ và chọn nhiều' },
          text: {
            en: 'Several download queues, selecting many downloads at once, YouTube downloads fixed and a macOS version.', vi: 'Nhiều hàng chờ tải xuống, chọn nhiều lượt tải cùng lúc, đã sửa tải YouTube và có bản macOS.',
          },
        },
      ],
    },
  ];

  const cmp = (a, b) => {
    const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    return 0;
  };

  /** Entries newer than `from` up to and including `to` (only `to` itself when `from` is unknown). */
  function between(from, to) {
    return ENTRIES.filter((e) => (from ? cmp(e.version, from) > 0 && cmp(e.version, to) <= 0 : e.version === to));
  }

  return { ENTRIES, between, cmp };
});
