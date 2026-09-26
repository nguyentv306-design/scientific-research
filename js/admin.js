/* ==========================================================================
   ADMIN.JS - Xử lý toàn bộ trang Admin:
   Quản lý file / Quản lý user / Upload / Lịch sử / Thảo luận
   Dùng cho: html/admin.html
   Phụ thuộc: js/config.js, js/comment.js (nhúng TRƯỚC file này)
   ========================================================================== */

// ---------- 1. TRẠNG THÁI DÙNG CHUNG TOÀN FILE ----------
let currentUser = null; // { id, name, isAdmin, isSuperAdmin }
let folderList = [];    // cache folder (dùng cho Upload + đổi folder)
let allFiles = [];      // cache toàn bộ file (Quản lý file)
let allUsers = [];      // cache toàn bộ user (Quản lý user)
let toastTimer;

const elSidebar = document.getElementById("sidebar");
const elBreadcrumbCurrent = document.getElementById("breadcrumbCurrent");
const elUserNameLabel = document.getElementById("userNameLabel");
const elUserAvatar = document.getElementById("userAvatar");

// ---------- 2. KHỞI CHẠY TRANG (auth guard + tải dữ liệu ban đầu) ----------
bootstrapAdminPage();

async function bootstrapAdminPage() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "login.html";
    return;
  }

  const { data: profile, error } = await supabaseClient
    .from("user")
    .select("user_name, status, is_admin, is_super_admin, color")
    .eq("id", session.user.id)
    .single();

  if (error || !profile || !profile.status) {
    await supabaseClient.auth.signOut();
    window.location.href = "login.html";
    return;
  }

  // Không phải Admin thì không được vào trang này
  if (!profile.is_admin) {
    window.location.href = "user.html";
    return;
  }

  currentUser = {
    id: session.user.id,
    name: profile.user_name || "Admin",
    email: session.user.email,
    isAdmin: true,
    isSuperAdmin: !!profile.is_super_admin,
  };

  elUserNameLabel.textContent = currentUser.name + (currentUser.isSuperAdmin ? " (Super Admin)" : "");
  elUserAvatar.textContent = currentUser.name.slice(0, 2).toUpperCase();

  initThemeToggle(profile.color);
  await loadFolders();
  await loadFiles();
  await loadUsers();
  await loadHistory();
  await loadSettings();
  await loadLeaderboard();
  await CommentModule.init("commentRoot", { userId: currentUser.id, isAdmin: true });
  restorePageFromHash();
}

// ---------- 3. ĐIỀU HƯỚNG GIỮA CÁC TAB ----------
document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-page]");
  if (nav) switchPage(nav.dataset.page);
});

document.getElementById("menuToggle").addEventListener("click", () => {
  elSidebar.classList.toggle("open");
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  window.location.href = "login.html";
});

const pageTitles = {
  files: "Quản lý file",
  folders: "Quản lý folder",
  users: "Quản lý user",
  upload: "Upload",
  history: "Lịch sử",
  discussion: "Thảo luận",
  settings: "Cài đặt",
  account: "Tài khoản",
};

function switchPage(page) {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === page);
  });
  document.querySelectorAll(".page").forEach((section) => section.classList.remove("active"));
  document.getElementById(`${page}Page`).classList.add("active");
  elBreadcrumbCurrent.textContent = pageTitles[page];
  elSidebar.classList.remove("open");

  // Ghi nhớ tab đang mở vào URL -> F5 lại vẫn giữ đúng tab, không nhảy về tab đầu
  if (window.location.hash !== `#${page}`) {
    history.replaceState(null, "", `#${page}`);
  }
}

// Khôi phục lại đúng tab đã mở trước đó (dựa vào URL hash) sau khi bootstrap xong
function restorePageFromHash() {
  const savedPage = window.location.hash.replace("#", "");
  if (savedPage && pageTitles[savedPage]) {
    switchPage(savedPage);
  }
}

// ==========================================================================
// TAB: QUẢN LÝ FILE
// ==========================================================================

document.getElementById("fileSearchInput").addEventListener("input", renderFileTable);

async function loadFiles() {
  const { data, error } = await supabaseClient
    .from("file")
    .select(
      "id, file_name, storage_path, status, created_at, id_folder, id_user, folder:id_folder(display_name, parent:parent_id(display_name)), user:id_user(user_name)"
    )
    .order("created_at", { ascending: false });

  if (error) {
    showToast("Không tải được file", error.message);
    return;
  }

  allFiles = data || [];
  renderFileTable();
}

// Hiện đường dẫn folder dạng "Cha / Con" nếu là folder con, chỉ tên nếu là folder gốc
function formatFolderPath(file) {
  const subName = file.folder?.display_name || "-";
  const parentName = file.folder?.parent?.display_name;
  return parentName ? `${parentName} / ${subName}` : subName;
}

function renderFileTable() {
  const rawKeyword = document.getElementById("fileSearchInput").value.trim().toLowerCase();
  let list;

  if (rawKeyword.includes("/")) {
    // Cú pháp đặc biệt "Tên folder cha/Tên folder con" -> tìm chính xác đúng cặp cha-con
    const [parentPart, subPart] = rawKeyword.split("/").map((s) => s.trim());
    list = allFiles.filter((file) => {
      const parentName = (file.folder?.parent?.display_name || "").toLowerCase();
      const subName = (file.folder?.display_name || "").toLowerCase();
      return parentName.includes(parentPart) && subName.includes(subPart || "");
    });
  } else {
    list = allFiles.filter((file) => {
      const subName = file.folder?.display_name || "";
      const parentName = file.folder?.parent?.display_name || "";
      const haystack = `${file.id} ${file.file_name} ${file.user?.user_name || ""} ${subName} ${parentName}`.toLowerCase();
      return haystack.includes(rawKeyword);
    });
  }

  document.getElementById("fileResultCount").textContent = list.length;
  document.getElementById("fileEmptyState").hidden = list.length > 0;
  document.querySelector("#filesPage .table-scroll").hidden = list.length === 0;

  const body = document.getElementById("fileTableBody");
  body.innerHTML = list.map(renderFileRow).join("");
  attachFileRowEvents(body);
}

function renderFileRow(file) {
  const statusHtml = file.status
    ? `<span class="status active">Hoạt động</span>`
    : `<span class="status inactive">Đã xóa mềm</span>`;

  return /* html */ `
    <tr data-file-id="${file.id}" data-storage-path="${escapeAttr(file.storage_path)}" data-status="${file.status}">
      <td>#${file.id}</td>
      <td>${escapeHTML(file.file_name)}</td>
      <td>${escapeHTML(formatFolderPath(file))}</td>
      <td>${escapeHTML(file.user?.user_name || "-")}</td>
      <td>${statusHtml}</td>
      <td>${formatDate(file.created_at)}</td>
      <td>
        <div class="actions">
          <button class="action-btn" data-view-file title="Xem">👁</button>
          <button class="action-btn" data-download-file title="Tải về">⬇</button>
          <button class="action-btn" data-rename-file title="Đổi tên">✎</button>
          <button class="action-btn" data-move-file title="Đổi folder">📁</button>
          <button class="action-btn" data-toggle-status="${file.status}" title="${file.status ? "Ẩn file" : "Hiện lại file"}">${file.status ? "🚫" : "↺"}</button>
          <button class="action-btn delete" data-purge-file title="Xóa vĩnh viễn">⌫</button>
        </div>
      </td>
    </tr>`;
}

function attachFileRowEvents(container) {
  container.querySelectorAll("tr[data-file-id]").forEach((row) => {
    const fileId = row.dataset.fileId;
    const storagePath = row.dataset.storagePath;

    row.querySelector("[data-view-file]")?.addEventListener("click", () => {
      const newTab = window.open("", "_blank");
      openFileUrl(storagePath, false, newTab);
    });
    row.querySelector("[data-download-file]")?.addEventListener("click", () => {
      const newTab = window.open("", "_blank");
      openFileUrl(storagePath, true, newTab);
    });
    row.querySelector("[data-rename-file]")?.addEventListener("click", () => renameFile(fileId, row));
    row.querySelector("[data-move-file]")?.addEventListener("click", () => openMoveFolderModal(fileId));
    const toggleBtn = row.querySelector("[data-toggle-status]");
    if (toggleBtn) {
      const currentStatus = toggleBtn.dataset.toggleStatus === "true";
      toggleBtn.addEventListener("click", () => toggleFileStatus(fileId, currentStatus));
    }
    row.querySelector("[data-purge-file]")?.addEventListener("click", () => purgeFile(fileId));
  });
}

async function openFileUrl(storagePath, isDownload, targetWindow) {
  const bucketName = storagePath.split("/")[0];
  const pathInsideBucket = storagePath.split("/").slice(1).join("/");
  const extension = pathInsideBucket.split(".").pop().toLowerCase();

  const { data, error } = await supabaseClient.storage
    .from(bucketName)
    .createSignedUrl(pathInsideBucket, 300, isDownload ? { download: true } : undefined);

  if (error) {
    showToast("Không mở được file", error.message);
    targetWindow?.close();
    return;
  }

  if (isDownload) {
    if (targetWindow) targetWindow.location.href = data.signedUrl;
    else window.open(data.signedUrl, "_blank");
    return;
  }

  const officeExtensions = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"];
  const finalUrl = officeExtensions.includes(extension)
    ? `https://docs.google.com/gview?url=${encodeURIComponent(data.signedUrl)}&embedded=true`
    : data.signedUrl;

  if (targetWindow) targetWindow.location.href = finalUrl;
  else window.open(finalUrl, "_blank");
}

async function renameFile(fileId, row) {
  const oldName = row.children[1].textContent;
  const newName = prompt("Nhập tên mới cho file:", oldName);
  if (!newName || newName.trim() === "" || newName === oldName) return;

  const { error } = await supabaseClient
    .from("file")
    .update({ file_name: newName.trim(), updated_at: new Date().toISOString() })
    .eq("id", fileId);

  if (error) return showToast("Không đổi tên được", error.message);

  await logHistory(fileId, "Đã sửa");
  showToast("Đã đổi tên file", "");
  await loadFiles();
}

let movingFileId = null;

function openMoveFolderModal(fileId) {
  movingFileId = fileId;
  const select = document.getElementById("moveFolderSelect");
  select.innerHTML = buildFolderOptionsHTML();
  document.getElementById("moveFolderModal").classList.add("open");
}

function closeMoveFolderModal() {
  document.getElementById("moveFolderModal").classList.remove("open");
  movingFileId = null;
}

document.querySelectorAll("[data-close-move-modal]").forEach((el) => {
  el.addEventListener("click", closeMoveFolderModal);
});

document.getElementById("moveFolderConfirmBtn").addEventListener("click", async () => {
  if (!movingFileId) return;
  const newFolderId = document.getElementById("moveFolderSelect").value;
  const target = folderList.find((f) => f.id === newFolderId);

  const { error } = await supabaseClient
    .from("file")
    .update({ id_folder: newFolderId, updated_at: new Date().toISOString() })
    .eq("id", movingFileId);

  if (error) {
    showToast("Không đổi được folder", error.message);
    return;
  }

  await logHistory(movingFileId, "Đã sửa");
  showToast("Đã chuyển folder", `Chuyển sang "${target?.display_name}"`);
  closeMoveFolderModal();
  await loadFiles();
});

async function toggleFileStatus(fileId, currentStatus) {
  const newStatus = !currentStatus;
  const { error } = await supabaseClient.from("file").update({ status: newStatus }).eq("id", fileId);
  if (error) return showToast("Không cập nhật được", error.message);

  await logHistory(fileId, newStatus ? "Đã sửa" : "Đã xóa");
  showToast(newStatus ? "Đã hiện lại file" : "Đã ẩn file", "");
  await loadFiles();
}

async function purgeFile(fileId) {
  const file = allFiles.find((f) => f.id === fileId);
  if (!file) return;
  if (!confirm(`XÓA VĨNH VIỄN file "${file.file_name}"? Không thể hoàn tác, kể cả lịch sử liên quan cũng sẽ mất.`)) return;

  try {
    // 1) Xóa các dòng lịch sử đang tham chiếu tới file này trước
    //    (DB chưa cấu hình tự xóa cascade, phải xóa tay để tránh lỗi khóa ngoại)
    const { error: historyError } = await supabaseClient.from("history_file").delete().eq("id_file", fileId);
    if (historyError) throw historyError;

    // 2) Xóa file vật lý khỏi Storage
    const bucketName = file.storage_path.split("/")[0];
    const pathInsideBucket = file.storage_path.split("/").slice(1).join("/");
    await supabaseClient.storage.from(bucketName).remove([pathInsideBucket]);

    // 3) Xóa dòng dữ liệu file
    const { error } = await supabaseClient.from("file").delete().eq("id", fileId);
    if (error) throw error;

    showToast("Đã xóa vĩnh viễn", `File "${file.file_name}" và lịch sử liên quan đã bị xóa.`);
    await loadFiles();
    await loadHistory();
    await loadLeaderboard();
  } catch (error) {
    showToast("Không xóa vĩnh viễn được", error.message);
  }
}

async function logHistory(fileId, change) {
  await supabaseClient.from("history_file").insert({ id_file: fileId, id_user: currentUser.id, change });
}

// ==========================================================================
// TAB: QUẢN LÝ USER
// ==========================================================================

document.getElementById("userSearchInput").addEventListener("input", renderUserTable);

async function loadUsers() {
  const { data, error } = await supabaseClient
    .from("user")
    .select("id, user_name, gender, status, is_admin, is_super_admin, last_sign_in_at")
    .order("created_at", { ascending: false });

  if (error) return showToast("Không tải được user", error.message);

  allUsers = data || [];
  await loadUserFileCounts();
  renderUserTable();
}

// Đếm tổng số file (kể cả đang ẩn) mỗi user đã từng upload, hiện trong bảng Quản lý user
async function loadUserFileCounts() {
  const results = await Promise.all(
    allUsers.map(async (u) => {
      const { count } = await supabaseClient
        .from("file")
        .select("id", { count: "exact", head: true })
        .eq("id_user", u.id);
      return { id: u.id, count: count || 0 };
    })
  );
  const countMap = Object.fromEntries(results.map((r) => [r.id, r.count]));
  allUsers = allUsers.map((u) => ({ ...u, fileCount: countMap[u.id] || 0 }));
}

function renderUserTable() {
  const keyword = document.getElementById("userSearchInput").value.trim().toLowerCase();
  const list = allUsers.filter((u) => (u.user_name || "").toLowerCase().includes(keyword));

  document.getElementById("userResultCount").textContent = list.length;
  document.getElementById("userEmptyState").hidden = list.length > 0;
  document.querySelector("#usersPage .table-scroll").hidden = list.length === 0;

  const body = document.getElementById("userTableBody");
  body.innerHTML = list.map(renderUserRow).join("");
  attachUserRowEvents(body);
}

function renderUserRow(user) {
  const statusHtml = user.status
    ? `<span class="status active">Đã duyệt</span>`
    : `<span class="status inactive">Chờ duyệt</span>`;

  let roleHtml = `<span class="badge">User</span>`;
  if (user.is_super_admin) roleHtml = `<span class="badge">Super Admin</span>`;
  else if (user.is_admin) roleHtml = `<span class="badge">Admin</span>`;

  const isSelf = user.id === currentUser.id;
  const canManageRole = currentUser.isSuperAdmin && !isSelf && !user.is_super_admin;
  const canDelete = !isSelf && !user.is_super_admin &&
    (currentUser.isSuperAdmin || !user.is_admin); // Admin thường chỉ xóa User thường
  // Duyệt/Khóa: Admin thường chỉ thao tác được với User thường; Super Admin thao tác được với mọi người (trừ chính mình)
  const canToggleStatus = !isSelf && (currentUser.isSuperAdmin || !user.is_admin);

  return /* html */ `
    <tr data-user-id="${user.id}">
      <td>${escapeHTML(user.user_name || "-")}</td>
      <td>${user.gender === true ? "Nam" : user.gender === false ? "Nữ" : "-"}</td>
      <td>${statusHtml}</td>
      <td>${roleHtml}</td>
      <td>${user.fileCount ?? 0}</td>
      <td>${user.last_sign_in_at ? formatDate(user.last_sign_in_at) : "-"}</td>
      <td>
        <div class="actions">
          ${!user.status && canToggleStatus ? `<button class="action-btn" data-approve-user title="Duyệt">✓</button>` : ""}
          ${user.status && canToggleStatus ? `<button class="action-btn" data-lock-user title="Khóa">🔒</button>` : ""}
          ${canManageRole
      ? `<button class="action-btn" data-toggle-admin title="${user.is_admin ? "Thu quyền Admin" : "Cấp quyền Admin"}">${user.is_admin ? "▾" : "▴"}</button>`
      : ""}
          ${canDelete ? `<button class="action-btn delete" data-delete-user title="Xóa">⌫</button>` : ""}
        </div>
      </td>
    </tr>`;
}

function attachUserRowEvents(container) {
  container.querySelectorAll("tr[data-user-id]").forEach((row) => {
    const userId = row.dataset.userId;

    row.querySelector("[data-approve-user]")?.addEventListener("click", () => setUserStatus(userId, true));
    row.querySelector("[data-lock-user]")?.addEventListener("click", () => setUserStatus(userId, false));
    row.querySelector("[data-toggle-admin]")?.addEventListener("click", () => toggleAdmin(userId, row));
    row.querySelector("[data-delete-user]")?.addEventListener("click", () => deleteUser(userId));
  });
}

async function setUserStatus(userId, status) {
  const { error } = await supabaseClient.from("user").update({ status }).eq("id", userId);
  if (error) return showToast("Không cập nhật được", error.message);

  showToast(status ? "Đã duyệt tài khoản" : "Đã khóa tài khoản", "");
  await loadUsers();
}

async function toggleAdmin(userId, row) {
  const user = allUsers.find((u) => u.id === userId);
  const { error } = await supabaseClient
    .from("user")
    .update({ is_admin: !user.is_admin })
    .eq("id", userId);

  if (error) return showToast("Không đổi được quyền", error.message);

  showToast(!user.is_admin ? "Đã cấp quyền Admin" : "Đã thu quyền Admin", "");
  await loadUsers();
}

async function deleteUser(userId) {
  if (!confirm("Xóa VĨNH VIỄN tài khoản này? Sẽ xóa cả quyền đăng nhập lẫn hồ sơ, không thể hoàn tác.")) return;

  const { data, error } = await supabaseClient.functions.invoke("delete-user", {
    body: { userId },
  });

  if (error || data?.error) {
    return showToast("Không xóa được", data?.error || error.message);
  }

  showToast("Đã xóa user", "Tài khoản đã được xóa hoàn toàn khỏi hệ thống.");
  await loadUsers();
}

// ==========================================================================
// TAB: UPLOAD (logic giống hệt bên User)
// ==========================================================================

document.getElementById("uploadForm").addEventListener("submit", handleUpload);

async function loadFolders() {
  const { data, error } = await supabaseClient
    .from("folder")
    .select("id, display_name, bucket_name, parent_id")
    .order("display_name");

  if (error) return showToast("Không tải được folder", error.message);

  folderList = data || [];

  const select = document.getElementById("uploadFolder");
  const roots = folderList.filter((f) => !f.parent_id);
  select.innerHTML =
    `<option value="">-- Chọn folder --</option>` +
    roots.map((f) => `<option value="${f.id}">${escapeHTML(f.display_name)}</option>`).join("");
  document.getElementById("uploadSubfolderWrap").hidden = true;

  renderFolderManageList();
  refreshFolderParentSelect();
}

// Khi đổi Folder cha ở tab Upload -> hiện thêm ô Folder con NẾU folder đó có con
document.getElementById("uploadFolder").addEventListener("change", (event) => {
  const parentId = event.target.value;
  const wrap = document.getElementById("uploadSubfolderWrap");
  const select = document.getElementById("uploadSubfolder");
  const subfolders = folderList.filter((f) => f.parent_id === parentId);

  if (!parentId || subfolders.length === 0) {
    wrap.hidden = true;
    select.value = "";
    return;
  }

  select.innerHTML =
    `<option value="">-- Không, để ở folder cha --</option>` +
    subfolders.map((f) => `<option value="${f.id}">${escapeHTML(f.display_name)}</option>`).join("");
  wrap.hidden = false;
});

// Xây danh sách option cho dropdown, folder con thụt vào để phân biệt với folder cha
function buildFolderOptionsHTML() {
  const roots = folderList.filter((f) => !f.parent_id);
  let html = "";
  roots.forEach((root) => {
    html += `<option value="${root.id}">${escapeHTML(root.display_name)}</option>`;
    folderList
      .filter((f) => f.parent_id === root.id)
      .forEach((sub) => {
        html += `<option value="${sub.id}">— ${escapeHTML(sub.display_name)}</option>`;
      });
  });
  return html;
}

// Đổ danh sách folder GỐC vào ô "Folder cha (tùy chọn)" trong form thêm folder
function refreshFolderParentSelect() {
  const select = document.getElementById("folderParentSelect");
  if (!select) return;
  const roots = folderList.filter((f) => !f.parent_id);
  select.innerHTML =
    `<option value="">-- Không có, đây là folder gốc --</option>` +
    roots.map((f) => `<option value="${f.id}">${escapeHTML(f.display_name)}</option>`).join("");
}

// ---------- Quản lý Folder (thêm / xóa) ----------
document.getElementById("folderForm").addEventListener("submit", handleAddFolder);

function renderFolderManageList() {
  const body = document.getElementById("folderManageBody");
  const roots = folderList.filter((f) => !f.parent_id);

  let html = "";
  roots.forEach((root) => {
    html += renderFolderManageRow(root, false);
    folderList.filter((f) => f.parent_id === root.id).forEach((sub) => {
      html += renderFolderManageRow(sub, true);
    });
  });
  body.innerHTML = html;

  body.querySelectorAll("[data-edit-folder]").forEach((btn) => {
    btn.addEventListener("click", () => handleEditFolder(btn.dataset.editFolder));
  });
  body.querySelectorAll("[data-delete-folder]").forEach((btn) => {
    btn.addEventListener("click", () => handleDeleteFolder(btn.dataset.deleteFolder));
  });
}

function renderFolderManageRow(f, isSub) {
  return /* html */ `
      <tr data-folder-id="${f.id}">
        <td>${isSub ? "— " : ""}${escapeHTML(f.display_name)}</td>
        <td>${escapeHTML(f.bucket_name)}</td>
        <td>
          <div class="actions">
            <button class="action-btn" data-edit-folder="${f.id}" title="Sửa tên">✎</button>
            <button class="action-btn delete" data-delete-folder="${f.id}" title="Xóa">⌫</button>
          </div>
        </td>
      </tr>`;
}

async function handleEditFolder(folderId) {
  const folder = folderList.find((f) => f.id === folderId);
  const newName = prompt("Nhập tên hiển thị mới cho folder:", folder?.display_name || "");
  if (!newName || newName.trim() === "" || newName === folder?.display_name) return;

  const { error } = await supabaseClient
    .from("folder")
    .update({ display_name: newName.trim() })
    .eq("id", folderId);

  if (error) return showToast("Không đổi được tên folder", error.message);

  showToast("Đã đổi tên folder", "");
  await loadFolders();
}

async function handleAddFolder(event) {
  event.preventDefault();
  const submitBtn = document.getElementById("folderSubmitBtn");
  const displayName = document.getElementById("folderDisplayName").value.trim();
  const parentId = document.getElementById("folderParentSelect")?.value || null;
  if (!displayName) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Đang tạo...";

  try {
    if (parentId) {
      // Folder CON: dùng chung bucket với folder cha, không cần tạo bucket mới
      const parentFolder = folderList.find((f) => f.id === parentId);
      const { error } = await supabaseClient.from("folder").insert({
        display_name: displayName,
        bucket_name: parentFolder.bucket_name,
        parent_id: parentId,
        created_by: currentUser.id,
      });
      if (error) throw error;

      showToast("Đã thêm folder con", `"${displayName}" đã sẵn sàng để upload.`);
    } else {
      // Folder GỐC: cần tạo bucket thật riêng
      const bucketName = slugify(displayName);
      if (!bucketName) throw new Error("Tên hiển thị không hợp lệ, vui lòng nhập tên khác.");

      const { data: bucketResult, error: bucketError } = await supabaseClient.functions.invoke("create-bucket", {
        body: { bucketName },
      });
      if (bucketError) throw bucketError;
      if (bucketResult?.error) throw new Error(bucketResult.error);

      const { error } = await supabaseClient
        .from("folder")
        .insert({ display_name: displayName, bucket_name: bucketName, created_by: currentUser.id });
      if (error) throw error;

      showToast("Đã thêm folder", `"${displayName}" đã sẵn sàng để upload (đã tự tạo bucket "${bucketName}").`);
    }

    document.getElementById("folderForm").reset();
    await loadFolders();
  } catch (error) {
    showToast("Không thêm được folder", error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "+ Thêm folder";
  }
}

// Chuyển tên tiếng Việt có dấu -> dạng "slug" hợp lệ để đặt tên bucket (vd: "Kế Toán" -> "ke-toan")
function slugify(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function handleDeleteFolder(folderId) {
  const folder = folderList.find((f) => f.id === folderId);
  const hasChildren = !folder?.parent_id && folderList.some((f) => f.parent_id === folderId);
  const warning = hasChildren ? " Folder con bên trong cũng sẽ bị xóa theo." : "";

  if (!confirm(`Xóa folder này? Chỉ xóa được nếu folder (và folder con, nếu có) không còn chứa file nào.${warning}`))
    return;

  const { error } = await supabaseClient.from("folder").delete().eq("id", folderId);

  if (error) {
    // Lỗi khóa ngoại xảy ra khi folder vẫn còn file bên trong tham chiếu tới
    if (error.message.includes("foreign key") || error.message.includes("violates"))
      return showToast("Không xóa được", "Folder này vẫn còn chứa file, hãy xóa/chuyển hết file trước.");
    return showToast("Không xóa được folder", error.message);
  }

  showToast("Đã xóa folder", "");
  await loadFolders();
}

async function handleUpload(event) {
  event.preventDefault();
  const submitBtn = document.getElementById("uploadSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = "Đang tải lên...";

  try {
    // Nếu có chọn Folder con -> upload vào đó; không thì upload vào Folder cha
    const parentFolderId = document.getElementById("uploadFolder").value;
    const subfolderId = document.getElementById("uploadSubfolder").value;
    const folderId = subfolderId || parentFolderId;
    const folder = folderList.find((f) => f.id === folderId);
    const rawFile = document.getElementById("uploadFile").files[0];
    const bio = document.getElementById("uploadBio").value.trim();
    let displayName = document.getElementById("uploadName").value.trim() || rawFile.name;

    if (!folder) throw new Error("Vui lòng chọn folder.");
    if (!rawFile) throw new Error("Vui lòng chọn file để tải lên.");

    displayName = await resolveDuplicateName(displayName, folderId);

    const safeExt = rawFile.name.includes(".") ? rawFile.name.split(".").pop() : "";
    const storageFileName = `${crypto.randomUUID()}${safeExt ? "." + safeExt : ""}`;
    const storagePath = `${folder.bucket_name}/${currentUser.id}/${storageFileName}`;
    const pathInsideBucket = `${currentUser.id}/${storageFileName}`;

    const { error: uploadError } = await supabaseClient.storage
      .from(folder.bucket_name)
      .upload(pathInsideBucket, rawFile);
    if (uploadError) throw uploadError;

    const { data: newFile, error: insertError } = await supabaseClient
      .from("file")
      .insert({ file_name: displayName, storage_path: storagePath, id_folder: folderId, id_user: currentUser.id, bio })
      .select()
      .single();
    if (insertError) throw insertError;

    await logHistory(newFile.id, "Đã thêm");

    showToast("Tải lên thành công", `File "${displayName}" đã được lưu.`);
    document.getElementById("uploadForm").reset();
    document.getElementById("uploadSubfolderWrap").hidden = true;
    await loadFiles();
    await loadLeaderboard();
  } catch (error) {
    showToast("Tải lên thất bại", error.message || "Vui lòng thử lại.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "⬆ Tải lên";
  }
}

async function resolveDuplicateName(name, folderId) {
  const { data } = await supabaseClient
    .from("file")
    .select("file_name")
    .eq("id_folder", folderId)
    .eq("id_user", currentUser.id)
    .eq("status", true);

  const existingNames = new Set((data || []).map((f) => f.file_name));
  if (!existingNames.has(name)) return name;

  let counter = 1;
  let candidate = `${name} (${counter})`;
  while (existingNames.has(candidate)) {
    counter += 1;
    candidate = `${name} (${counter})`;
  }
  return candidate;
}

// ==========================================================================
// TAB: LỊCH SỬ (chỉ xem)
// ==========================================================================

async function loadHistory() {
  const [fileHistoryResult, adminHistoryResult] = await Promise.all([
    supabaseClient
      .from("history_file")
      .select("id, created_at, change, file:id_file(file_name), user:id_user(user_name)")
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseClient
      .from("history_admin")
      .select("id, created_at, action, actor:actor_id(user_name), target:target_id(user_name)")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  if (fileHistoryResult.error) return showToast("Không tải được lịch sử file", fileHistoryResult.error.message);
  if (adminHistoryResult.error) return showToast("Không tải được lịch sử phân quyền", adminHistoryResult.error.message);

  // Gộp 2 nguồn thành 1 danh sách chung, mỗi dòng tự biết cách hiển thị chính mình
  const fileEntries = (fileHistoryResult.data || []).map((h) => ({
    time: h.created_at,
    target: h.file?.file_name || "(file đã bị xóa vĩnh viễn)",
    actor: h.user?.user_name || "-",
    action: h.change,
  }));

  const adminEntries = (adminHistoryResult.data || []).map((h) => ({
    time: h.created_at,
    target: h.target?.user_name || "-",
    actor: h.actor?.user_name || "-",
    action: h.action,
  }));

  const merged = [...fileEntries, ...adminEntries].sort((a, b) => new Date(b.time) - new Date(a.time));

  document.getElementById("historyEmptyState").hidden = merged.length > 0;
  document.querySelector("#historyPage .table-scroll").hidden = merged.length === 0;

  document.getElementById("historyTableBody").innerHTML = merged
    .map(
      (h) => /* html */ `
      <tr>
        <td>${formatDateTime(h.time)}</td>
        <td>${escapeHTML(h.target)}</td>
        <td>${escapeHTML(h.actor)}</td>
        <td>${escapeHTML(h.action)}</td>
      </tr>`
    )
    .join("");
}

// ==========================================================================
// TAB: CÀI ĐẶT (site_setting - chỉ có 1 dòng duy nhất, id = 1)
// ==========================================================================

document.getElementById("settingsForm").addEventListener("submit", handleSaveSettings);

async function loadSettings() {
  const { data, error } = await supabaseClient
    .from("site_setting")
    .select("phone, email, facebook")
    .eq("id", 1)
    .single();

  if (error || !data) return; // chưa có dòng dữ liệu nào -> để trống cho Admin tự điền lần đầu

  document.getElementById("settingPhone").value = data.phone || "";
  document.getElementById("settingEmail").value = data.email || "";
  document.getElementById("settingFacebook").value = data.facebook || "";
}

async function handleSaveSettings(event) {
  event.preventDefault();
  const submitBtn = document.getElementById("settingsSubmitBtn");
  submitBtn.disabled = true;

  const payload = {
    id: 1,
    phone: document.getElementById("settingPhone").value.trim(),
    email: document.getElementById("settingEmail").value.trim(),
    facebook: document.getElementById("settingFacebook").value.trim(),
    updated_at: new Date().toISOString(),
  };

  // upsert: nếu dòng id=1 chưa tồn tại thì tự tạo mới, có rồi thì cập nhật
  const { error } = await supabaseClient.from("site_setting").upsert(payload);

  submitBtn.disabled = false;
  if (error) return showToast("Không lưu được", error.message);

  showToast("Đã lưu cài đặt", "Thông tin liên hệ đã được cập nhật.");
}

// ==========================================================================
// TAB: TÀI KHOẢN (đổi tên hiển thị / đổi mật khẩu - cần xác thực mật khẩu hiện tại)
// ==========================================================================

document.getElementById("accountForm").addEventListener("submit", handleUpdateAccount);

async function handleUpdateAccount(event) {
  event.preventDefault();
  const submitBtn = document.getElementById("accountSubmitBtn");
  submitBtn.disabled = true;

  try {
    const newName = document.getElementById("accountNewName").value.trim();
    const newPassword = document.getElementById("accountNewPassword").value;
    const confirmPassword = document.getElementById("accountConfirmPassword").value;
    const currentPassword = document.getElementById("accountCurrentPassword").value;

    if (!newName && !newPassword) throw new Error("Bạn chưa nhập gì để cập nhật.");
    if (newPassword && newPassword !== confirmPassword) throw new Error("Mật khẩu mới nhập lại không khớp.");
    if (newPassword && newPassword.length < 6) throw new Error("Mật khẩu mới cần tối thiểu 6 ký tự.");

    const { error: reauthError } = await supabaseClient.auth.signInWithPassword({
      email: currentUser.email,
      password: currentPassword,
    });
    if (reauthError) throw new Error("Mật khẩu hiện tại không đúng.");

    if (newName) {
      const { error } = await supabaseClient.from("user").update({ user_name: newName }).eq("id", currentUser.id);
      if (error) throw error;
      currentUser.name = newName;
      elUserNameLabel.textContent = currentUser.name + (currentUser.isSuperAdmin ? " (Super Admin)" : "");
      elUserAvatar.textContent = currentUser.name.slice(0, 2).toUpperCase();
    }

    if (newPassword) {
      const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
      if (error) throw error;
    }

    showToast("Đã cập nhật tài khoản", "");
    document.getElementById("accountForm").reset();
  } catch (error) {
    showToast("Không cập nhật được", error.message || "Vui lòng thử lại.");
  } finally {
    submitBtn.disabled = false;
  }
}

// ==========================================================================
// HÀM TIỆN ÍCH DÙNG CHUNG
// ==========================================================================

function showToast(title, message) {
  clearTimeout(toastTimer);
  document.getElementById("toastTitle").textContent = title;
  document.getElementById("toastMessage").textContent = message;
  document.getElementById("toast").classList.add("show");
  toastTimer = setTimeout(() => document.getElementById("toast").classList.remove("show"), 2800);
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleDateString("vi-VN");
}

function formatDateTime(isoString) {
  return new Date(isoString).toLocaleString("vi-VN");
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char];
  });
}

function escapeAttr(value = "") {
  return escapeHTML(value);
}

// ---------- TỰ ĐỘNG GẮN NÚT "HIỆN/ẨN MẬT KHẨU" VÀO MỌI Ô PASSWORD TRÊN TRANG ----------
function enablePasswordToggles() {
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.toggleAttached) return;
    input.dataset.toggleAttached = "true";

    const wrapper = document.createElement("div");
    wrapper.className = "password-field-wrap";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "password-toggle-btn";
    toggleBtn.textContent = "👁";
    toggleBtn.setAttribute("aria-label", "Hiện/ẩn mật khẩu");
    wrapper.appendChild(toggleBtn);

    toggleBtn.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggleBtn.textContent = showing ? "👁" : "🙈";
    });
  });
}
enablePasswordToggles();

// ---------- DARK / LIGHT MODE (lưu vào cột "color" trong bảng user) ----------
function applyTheme(isDark) {
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
}

function initThemeToggle(isDark) {
  applyTheme(isDark);
  const toggle = document.getElementById("darkModeToggle");
  toggle.checked = !!isDark;

  toggle.addEventListener("change", async () => {
    const newValue = toggle.checked;
    applyTheme(newValue);
    await supabaseClient.from("user").update({ color: newValue }).eq("id", currentUser.id);
  });
}

// ---------- BẢNG XẾP HẠNG: ai upload nhiều file nhất ----------
async function loadLeaderboard() {
  const { data, error } = await supabaseClient
    .from("user")
    .select("user_name, score")
    .order("score", { ascending: false })
    .limit(5);

  const list = document.getElementById("leaderboardList");
  if (error || !data || data.length === 0) {
    list.innerHTML = `<p style="color:var(--text-sub);font-size:0.85rem;">Chưa có dữ liệu.</p>`;
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  list.innerHTML = data
    .map((u, i) => /* html */ `
      <div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;border-bottom:1px solid var(--border-color);">
        <span style="width:1.5rem;text-align:center;">${medals[i] || i + 1}</span>
        <span style="flex:1;">${escapeHTML(u.user_name || "Ẩn danh")}</span>
        <strong>${u.score ?? 0} file</strong>
      </div>`)
    .join("");
}