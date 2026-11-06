// Runs a command inside a kill-on-close Job Object and forwards its exit code.
//
// Usage: job-launcher <end|keep> <command line>
//
// When this launcher ends for any reason, Windows ends every process in the job, so killing the
// launcher ends the whole tree, including children whose parent has already gone. In `keep` mode
// that protection is lifted once the tool exits by itself, which leaves the processes it started
// running. Killing the launcher before that point still ends everything.
#include <windows.h>
#include <string>

namespace {

// Failures of the launcher itself. These stay clear of ordinary exit codes, so core can tell them
// from a tool's own result. Keep in sync with launcher-exit-codes.ts.
constexpr DWORD kUsageError = 0xB1D00001;
constexpr DWORD kJobSetupError = 0xB1D00002;
constexpr DWORD kCommandNotStarted = 0xB1D00003;
constexpr DWORD kJobAssignError = 0xB1D00004;

constexpr wchar_t kBlanks[] = L" \t";

// Returns the position just past the token starting at `start`, which may be quoted.
size_t SkipToken(const std::wstring& line, size_t start) {
  if (start < line.size() && line[start] == L'"') {
    const size_t closing = line.find(L'"', start + 1);
    return closing == std::wstring::npos ? line.size() : closing + 1;
  }
  const size_t end = line.find_first_of(kBlanks, start);
  return end == std::wstring::npos ? line.size() : end;
}

// Returns the rest of the raw command line after `count` tokens. GetCommandLineW is used because
// argv has already lost the original quoting, which the tool must receive unchanged.
std::wstring CommandAfterTokens(const std::wstring& line, int count) {
  size_t position = 0;
  for (int token = 0; token < count; ++token) {
    position = SkipToken(line, position);
    position = line.find_first_not_of(kBlanks, position);
    if (position == std::wstring::npos) {
      return L"";
    }
  }
  return line.substr(position);
}

bool SetKillOnClose(HANDLE job, bool enabled) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = enabled ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0;
  return SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits);
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 3) {
    return static_cast<int>(kUsageError);
  }
  const std::wstring mode = argv[1];
  if (mode != L"end" && mode != L"keep") {
    return static_cast<int>(kUsageError);
  }
  std::wstring command = CommandAfterTokens(GetCommandLineW(), 2);

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job == nullptr || !SetKillOnClose(job, true)) {
    return static_cast<int>(kJobSetupError);
  }

  STARTUPINFOW startup = {};
  startup.cb = sizeof startup;
  PROCESS_INFORMATION process = {};
  // Suspended, so the tool cannot start a child before it is inside the job.
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED, nullptr,
                      nullptr, &startup, &process)) {
    return static_cast<int>(kCommandNotStarted);
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, kJobAssignError);
    return static_cast<int>(kJobAssignError);
  }
  ResumeThread(process.hThread);

  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exitCode = 1;
  GetExitCodeProcess(process.hProcess, &exitCode);

  // Only reached if the tool exited by itself: a killed launcher still closes the job armed.
  if (mode == L"keep") {
    SetKillOnClose(job, false);
  }
  return static_cast<int>(exitCode);
}
