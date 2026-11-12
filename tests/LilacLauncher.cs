using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class LilacLauncher
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string electron = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);
        if (!File.Exists(electron))
        {
            MessageBox.Show(
                "未找到 Electron 运行环境。\n请确认 node_modules 文件夹与启动器在同一目录。",
                "紫语星枢 · 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return;
        }

        var info = new ProcessStartInfo(electron)
        {
            WorkingDirectory = root,
            UseShellExecute = true,
            Arguments = "\"" + root + "\""
        };
        try
        {
            Process.Start(info);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "无法启动紫语星枢：\n" + ex.Message,
                "紫语星枢 · 启动失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
        }
    }
}
