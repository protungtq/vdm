# VN Browser

Trình duyệt Android gọn nhẹ: nhiều tab, chặn quảng cáo, lịch sử, dấu trang,
sao lưu và khôi phục. Dùng engine WebView (Chromium) sẵn trong máy.

## Tính năng (0.1.0)

- Nhiều tab: mở, đóng, chuyển tab; mở lại app vẫn còn tab cũ.
- Chặn quảng cáo theo 4 bộ lọc: FMSF 2.0, ABPVN, AdGuard Mobile Ads,
  EasyList. Bộ lọc tải về máy, tự kiểm tra bản mới mỗi 24 giờ.
- Lịch sử duyệt web: xem, tìm, xóa từng mục hoặc xóa hết.
- Dấu trang: gắn sao trang đang xem, mở lại nhanh.
- Sao lưu và khôi phục: xuất dấu trang, lịch sử, cài đặt và tab đã lưu ra
  file JSON, khôi phục lại trên máy khác.
- Tải file bằng DownloadManager của máy, có kèm cookie và User-Agent.

## Build

Đẩy code lên nhánh `main` là GitHub Actions tự build APK (file workflow
`.github/workflows/browser.yml`, build nhờ trong repo `vdm`, tách repo riêng sau).

## Ghi công

- Bộ lọc quảng cáo: [FMSF 2.0](https://github.com/nmtrung/FMSF-2.0),
  [ABPVN](https://github.com/abpvn/abpvn),
  [AdGuard](https://adguard.com),
  [EasyList](https://easylist.to).
- VN Browser được làm bởi TungTQ.

## Giấy phép

MIT — xem file `LICENSE`.
