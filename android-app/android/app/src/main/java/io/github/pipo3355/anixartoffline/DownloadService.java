package io.github.pipo3355.anixartoffline;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Служба «на переднем плане», пока идут загрузки: с ней Android не выгружает приложение
 * и не отключает ему сеть, когда оно свёрнуто или экран погашен. Сами загрузки
 * ведёт JS-часть приложения; служба только держит процесс живым и показывает уведомление.
 */
public class DownloadService extends Service {

    private static final String CHANNEL = "downloads";
    private static final int NOTIFICATION_ID = 7301;
    private static final String EXTRA_TEXT = "text";
    private static final String EXTRA_PROGRESS = "progress";

    private static DownloadService instance;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    /** Запустить службу или обновить её уведомление. progress — 0..100 или -1 (неизвестно). */
    public static void update(Context ctx, String text, int progress) {
        if (instance != null) {
            instance.show(text, progress);
            return;
        }
        Intent intent = new Intent(ctx, DownloadService.class);
        intent.putExtra(EXTRA_TEXT, text);
        intent.putExtra(EXTRA_PROGRESS, progress);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent);
        else ctx.startService(intent);
    }

    public static void stop(Context ctx) {
        if (instance != null) instance.finish();
        else ctx.stopService(new Intent(ctx, DownloadService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Загрузки", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Прогресс скачивания серий");
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AnixartOffline:downloads");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(6 * 60 * 60 * 1000L);
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? WifiManager.WIFI_MODE_FULL_HIGH_PERF : WifiManager.WIFI_MODE_FULL;
            wifiLock = wm.createWifiLock(mode, "AnixartOffline:downloads");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        int progress = intent != null ? intent.getIntExtra(EXTRA_PROGRESS, -1) : -1;
        Notification n = build(text, progress);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Exception e) {
            // система не разрешила (например, запуск из фона) — просто не держим процесс
            finish();
        }
        // если систему всё же убьёт процесс — не перезапускаем пустую службу (загрузки продолжатся при открытии)
        return START_NOT_STICKY;
    }

    private Notification build(String text, int progress) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("Скачивание")
                .setContentText(text != null ? text : "Идёт загрузка серий")
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (progress >= 0) b.setProgress(100, progress, false);
        else b.setProgress(0, 0, true);
        return b.build();
    }

    private void show(String text, int progress) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        try { nm.notify(NOTIFICATION_ID, build(text, progress)); } catch (Exception ignored) {}
    }

    private void finish() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    /** Приложение смахнули из недавних — JS-часть уже не работает, держать службу незачем. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        finish();
        super.onTaskRemoved(rootIntent);
    }

    /** Android 15 ограничивает такие службы по времени — по сигналу останавливаемся. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        finish();
    }

    @Override
    public void onDestroy() {
        instance = null;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
