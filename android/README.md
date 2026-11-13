# VDM cho Android

Bản mobile gọn nhẹ của VN Download Manager, nằm trong cùng repo với bản
desktop. Đang lướt Facebook, YouTube, TikTok hay bất kỳ trang nào, bấm
**Chia sẻ** rồi chọn **VDM** là app tự quét link và tải video về máy. Cũng có
thể mở app và dán link vào.

- Mã gói (applicationId): `tungtq.so1.asia`
- Tên hiển thị: VDM

## Tính năng (bản 0.1.0)

- Nhận link qua nút Chia sẻ của Android (ACTION_SEND, text/plain).
- Quét link bằng yt-dlp, hiện tiêu đề, ảnh đại diện, thời lượng và danh sách
  chất lượng (1080p, 720p…), kèm lựa chọn chỉ lấy âm thanh MP3.
- Tải ở chế độ foreground service nên vẫn chạy khi tắt màn hình hay chuyển app,
  có thông báo tiến trình.
- Tải đa kết nối bằng aria2c, gộp video + âm thanh bằng FFmpeg.
- File lưu trong thư mục `Download/VDM/` trên điện thoại.
- Cập nhật bộ quét yt-dlp trong app (không cần chờ bản app mới).

## Bộ máy

- [youtubedl-android](https://github.com/yausername/youtubedl-android) 0.18.1
  (nhúng Python + yt-dlp, FFmpeg, aria2c).
- Kotlin + Jetpack Compose (Material 3), minSdk 26 (Android 8.0+).

## Build

Bản debug (chưa ký release), chạy trong thư mục `android/`:

```sh
gradle assembleDebug
```

APK ra ở `app/build/outputs/apk/debug/` (chia theo kiến trúc CPU + 1 bản
universal). GitHub Actions tự build mỗi lần có thay đổi trong thư mục
`android/` và đính kèm APK vào mục Artifacts của lần chạy đó.

Yêu cầu: JDK 17, Android SDK với platform API 35.

## Giấy phép

Thư mục `android/` này phát hành theo **GPL-3.0** (xem file `LICENSE`), do
dùng thư viện youtubedl-android (GPL-3.0). Bản desktop ở gốc repo vẫn giữ
giấy phép MIT như cũ — hai phần tách bạch nhau.

## Ghi công

- yt-dlp và youtubedl-android (yausername) — bộ máy quét và tải video.
- FFmpeg — gộp video/âm thanh và tách MP3.
- aria2c — tải đa kết nối.
