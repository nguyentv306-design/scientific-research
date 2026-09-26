/* ==========================================================================
   USER.JS - Xử lý toàn bộ trang User: Tài liệu / Upload / Tìm kiếm / Thảo luận
   Dùng cho: html/user.html
   Phụ thuộc: js/config.js, js/comment.js (nhúng TRƯỚC file này)
   ========================================================================== */

// ---------- 1. TRẠNG THÁI DÙNG CHUNG TOÀN FILE ----------
let currentUser = null;      // { id, name }
let folderList = [];         // cache toàn bộ folder (lấy 1 lần)
let currentFolderId = null;  // folder đang được chọn xem, null = đang ở lưới folder
let searchDataLoaded = false; // tránh load lại danh sách tìm kiếm nhiều lần
let allSearchableFiles = []; // cache toàn bộ file dùng cho tab Tìm kiếm
let toastTimer;

// ---------- 2. LẤY PHẦN TỬ HTML HAY DÙNG ----------
const elSidebar = document.getElementById("sidebar");
const elBreadcrumbCurrent = document.getElementById("breadcrumbCurrent");
const elUserNameLabel = document.getElementById("userNameLabel");
const elUserAvatar = document.getElementById("userAvatar");

// ---------- 3. KHỞI CHẠY TRANG (auth guard + tải dữ liệu ban đầu) ----------
bootstrapUserPage();

async function bootstrapUserPage() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "login.html";
    return;
  }

  const { data: profile, error } = await supabaseClient
    .from("user")
    .select("user_name, status, is_admin, color")
    .eq("id", session.user.id)
    .single();

  if (error || !profile || !profile.status) {
    await supabaseClient.auth.signOut();
    window.location.href = "login.html";
    return;
  }

  // Admin thì không ở trang User, đẩy sang trang riêng
  if (profile.is_admin) {
    window.location.href = "admin.html";
    return;
  }

  currentUser = { id: session.user.id, name: profile.user_name || "Người dùng", email: session.user.email };
  elUserNameLabel.textContent = currentUser.name;
  elUserAvatar.textContent = currentUser.name.slice(0, 2).toUpperCase();

  initThemeToggle(profile.color);
  await loadFolders();
  await loadMyFileCount();
  await loadLeaderboard();
  await CommentModule.init("commentRoot", { userId: currentUser.id, isAdmin: false });
  restorePageFromHash();
}

// Tổng số file (kể cả đang ẩn) mà chính user này đã từng upload, hiện ở khung hồ sơ sidebar
async function loadMyFileCount() {
  const { count } = await supabaseClient
    .from("file")
    .select("id", { count: "exact", head: true })
    .eq("id_user", currentUser.id);

  document.getElementById("userFileCountLabel").textContent = `${count || 0} file đã upload`;
}

// ---------- 4. ĐIỀU HƯỚNG GIỮA CÁC TAB ----------
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
  documents: "Tài liệu",
  upload: "Upload",
  search: "Tìm kiếm",
  discussion: "Thảo luận",
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

  if (page === "search" && !searchDataLoaded) {
    loadSearchData();
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
// TAB: TÀI LIỆU (folder -> file)
// ==========================================================================

async function loadFolders() {
  const { data, error } = await supabaseClient
    .from("folder")
    .select("id, display_name, bucket_name, parent_id")
    .order("display_name");

  if (error) {
    showToast("Không tải được folder", error.message);
    return;
  }

  folderList = data || [];
  await loadFolderFileCounts();
  renderFolderGrid();
}

// Đếm số file (đang hoạt động) trong từng folder, hiện dưới tên folder
async function loadFolderFileCounts() {
  const results = await Promise.all(
    folderList.map(async (folder) => {
      const { count } = await supabaseClient
        .from("file")
        .select("id", { count: "exact", head: true })
        .eq("id_folder", folder.id)
        .eq("status", true);
      return { id: folder.id, count: count || 0 };
    })
  );
  const countMap = Object.fromEntries(results.map((r) => [r.id, r.count]));
  folderList = folderList.map((f) => ({ ...f, fileCount: countMap[f.id] || 0 }));
}

function renderFolderGrid() {
  const grid = document.getElementById("folderGrid");
  const rootFolders = folderList.filter((f) => !f.parent_id);

  grid.innerHTML = rootFolders
    .map(
      (folder) => /* html */ `
      <article class="stat-card" data-folder-id="${folder.id}">
        <span class="stat-icon">▦</span>
        <div class="stat-copy">
          <strong>${escapeHTML(folder.display_name)}</strong>
          <span>${folder.fileCount ?? 0} file</span>
        </div>
        <b>›</b>
      </article>`
    )
    .join("");

  grid.querySelectorAll("[data-folder-id]").forEach((card) => {
    card.addEventListener("click", () => openFolder(card.dataset.folderId));
  });

  // Chỉ hiện mũi tên lướt ngang khi tràn khỏi màn hình (không cần thiết thì tự ẩn)
  const prevBtn = document.getElementById("folderPrevBtn");
  const nextBtn = document.getElementById("folderNextBtn");
  const canScroll = grid.scrollWidth > grid.clientWidth;
  prevBtn.hidden = !canScroll;
  nextBtn.hidden = !canScroll;
}

document.getElementById("folderPrevBtn").addEventListener("click", () => {
  document.getElementById("folderGrid").scrollBy({ left: -240, behavior: "smooth" });
});
document.getElementById("folderNextBtn").addEventListener("click", () => {
  document.getElementById("folderGrid").scrollBy({ left: 240, behavior: "smooth" });
});

async function openFolder(folderId) {
  currentFolderId = folderId;
  const folder = folderList.find((f) => f.id === folderId);
  const isRootFolder = !folder.parent_id;

  document.getElementById("documentsTitle").textContent = folder.display_name;
  document.getElementById("documentsDesc").textContent = isRootFolder
    ? "Folder con (nếu có) và file trực tiếp trong folder này"
    : "Danh sách file trong folder con này";

  // Mobile (màn hẹp): chuyển hẳn qua màn hình file, ẩn lưới folder đi
  // PC (màn rộng): giữ nguyên lưới folder ở trên, chỉ hiện thêm khối file bên dưới
  const isMobile = window.innerWidth <= 640;
  document.querySelector(".folder-scroll-wrap").hidden = isMobile;

  // Folder con chỉ có ở CẤP 1 (folder gốc) - nếu đang mở 1 folder con rồi thì không hiện khu vực này nữa
  const subfolderSection = document.getElementById("subfolderSection");
  if (isRootFolder) {
    subfolderSection.hidden = false;
    renderSubfolderGrid(folderId);
  } else {
    subfolderSection.hidden = true;
  }

  document.getElementById("fileListCard").hidden = false;
  document.getElementById("backToFoldersBtn").hidden = false;

  await loadFilesInFolder(folderId);
}

document.getElementById("backToFoldersBtn").addEventListener("click", () => {
  currentFolderId = null;
  document.getElementById("documentsTitle").textContent = "Tất cả folder";
  document.getElementById("documentsDesc").textContent = "Chọn 1 folder để xem file bên trong";
  document.querySelector(".folder-scroll-wrap").hidden = false;
  document.getElementById("subfolderSection").hidden = true;
  document.getElementById("addSubfolderForm").hidden = true;
  document.getElementById("fileListCard").hidden = true;
  document.getElementById("backToFoldersBtn").hidden = true;
});

// ---------- FOLDER CON (1 cấp, dùng chung bucket với folder cha) ----------
function renderSubfolderGrid(parentId) {
  const grid = document.getElementById("subfolderGrid");
  const subfolders = folderList.filter((f) => f.parent_id === parentId);

  if (subfolders.length === 0) {
    grid.innerHTML = `<p style="color:var(--text-sub);font-size:0.85rem;">Chưa có folder con nào.</p>`;
    return;
  }

  grid.innerHTML = subfolders
    .map(
      (folder) => /* html */ `
      <article class="stat-card" data-folder-id="${folder.id}">
        <span class="stat-icon">📁</span>
        <div class="stat-copy">
          <strong>${escapeHTML(folder.display_name)}</strong>
          <span>${folder.fileCount ?? 0} file</span>
        </div>
        <b>›</b>
      </article>`
    )
    .join("");

  grid.querySelectorAll("[data-folder-id]").forEach((card) => {
    card.addEventListener("click", () => openFolder(card.dataset.folderId));
  });
}

document.getElementById("showAddSubfolderBtn").addEventListener("click", () => {
  const form = document.getElementById("addSubfolderForm");
  form.hidden = !form.hidden;
});

document.getElementById("addSubfolderForm").addEventListener("submit", handleAddSubfolder);

async function handleAddSubfolder(event) {
  event.preventDefault();
  const submitBtn = document.getElementById("addSubfolderSubmitBtn");
  const displayName = document.getElementById("newSubfolderName").value.trim();
  if (!displayName || !currentFolderId) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Đang tạo...";

  try {
    const parentFolder = folderList.find((f) => f.id === currentFolderId);
    // Folder con dùng CHUNG bucket với folder cha -> không cần gọi Edge Function tạo bucket mới
    const { error } = await supabaseClient.from("folder").insert({
      display_name: displayName,
      bucket_name: parentFolder.bucket_name,
      parent_id: currentFolderId,
      created_by: currentUser.id,
    });
    if (error) throw error;

    showToast("Đã tạo folder con", `"${displayName}" đã sẵn sàng để upload.`);
    document.getElementById("newSubfolderName").value = "";
    document.getElementById("addSubfolderForm").hidden = true;
    await loadFolders();
    renderSubfolderGrid(currentFolderId);
  } catch (error) {
    showToast("Không tạo được folder con", error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Tạo folder con";
  }
}

async function loadFilesInFolder(folderId) {
  const { data, error } = await supabaseClient
    .from("file")
    .select("id, file_name, storage_path, bio, created_at, id_user, status, user:id_user(user_name)")
    .eq("id_folder", folderId)
    .order("created_at", { ascending: false });

  if (error) {
    showToast("Không tải được file", error.message);
    return;
  }

  // User thấy: mọi file đang hoạt động (status=true) + file CỦA CHÍNH MÌNH dù đang bị ẩn
  const visibleFiles = (data || []).filter((f) => f.status || f.id_user === currentUser.id);
  renderFileList(visibleFiles);
}

function renderFileList(files) {
  const body = document.getElementById("fileListBody");
  document.getElementById("fileCount").textContent = files.length;
  document.getElementById("fileEmptyState").hidden = files.length > 0;
  document.querySelector("#fileListCard .table-scroll").hidden = files.length === 0;

  body.innerHTML = files.map((file) => renderFileRow(file)).join("");
  attachFileRowEvents(body);
}

function renderFileRow(file) {
  const isOwner = file.id_user === currentUser.id;
  const uploaderName = file.user?.user_name || "?";
  const statusBadge = file.status
    ? `<span class="status active">Hoạt động</span>`
    : `<span class="status inactive">Đã ẩn</span>`;

  return /* html */ `
    <tr data-file-id="${file.id}" data-storage-path="${escapeAttr(file.storage_path)}">
      <td>${escapeHTML(file.file_name)}</td>
      <td>${escapeHTML(uploaderName)}</td>
      <td>${formatDate(file.created_at)}</td>
      <td>${escapeHTML(file.bio || "-")}</td>
      <td>${statusBadge}</td>
      <td>
        <div class="actions">
          <button class="action-btn" data-view-file title="Xem">👁</button>
          <button class="action-btn" data-download-file title="Tải về">⬇</button>
          ${isOwner ? `<button class="action-btn" data-rename-file title="Đổi tên">✎</button>` : ""}
          ${isOwner ? `<button class="action-btn" data-move-file title="Đổi folder">📁</button>` : ""}
          ${isOwner
      ? `<button class="action-btn" data-toggle-status="${file.status}" title="${file.status ? "Ẩn file" : "Hiện lại file"}">${file.status ? "🚫" : "↺"}</button>`
      : ""}
          ${isOwner ? `<button class="action-btn delete" data-delete-file title="Xóa vĩnh viễn">⌫</button>` : ""}
        </div>
      </td>
    </tr>`;
}

function attachFileRowEvents(container) {
  container.querySelectorAll("tr[data-file-id]").forEach((row) => {
    const fileId = row.dataset.fileId;
    const storagePath = row.dataset.storagePath;

    row.querySelector("[data-view-file]")?.addEventListener("click", () => {
      // Mở sẵn 1 tab trắng NGAY LÚC bấm (đồng bộ) để trình duyệt mobile không chặn popup
      const newTab = window.open("", "_blank");
      openFileUrl(storagePath, false, newTab);
    });
    row.querySelector("[data-download-file]")?.addEventListener("click", () => {
      const newTab = window.open("", "_blank");
      openFileUrl(storagePath, true, newTab);
    });
    row.querySelector("[data-rename-file]")?.addEventListener("click", () => renameFile(fileId, row));
    row.querySelector("[data-move-file]")?.addEventListener("click", () => openMoveFolderModal(fileId));
    row.querySelector("[data-delete-file]")?.addEventListener("click", () => deleteFileForever(fileId, storagePath));

    const toggleBtn = row.querySelector("[data-toggle-status]");
    if (toggleBtn) {
      const currentStatus = toggleBtn.dataset.toggleStatus === "true";
      toggleBtn.addEventListener("click", () => toggleFileStatus(fileId, currentStatus));
    }
  });
}

// Xóa VĨNH VIỄN file của chính mình (khác với Ẩn/Hiện - đây không khôi phục được)
async function deleteFileForever(fileId, storagePath) {
  if (!confirm("XÓA VĨNH VIỄN file này? Không thể hoàn tác, kể cả lịch sử liên quan cũng sẽ mất.")) return;

  try {
    // 1) Xóa lịch sử liên quan trước (tránh lỗi khóa ngoại)
    const { error: historyError } = await supabaseClient.from("history_file").delete().eq("id_file", fileId);
    if (historyError) throw historyError;

    // 2) Xóa file vật lý khỏi Storage
    const bucketName = storagePath.split("/")[0];
    const pathInsideBucket = storagePath.split("/").slice(1).join("/");
    await supabaseClient.storage.from(bucketName).remove([pathInsideBucket]);

    // 3) Xóa dòng dữ liệu file
    const { error } = await supabaseClient.from("file").delete().eq("id", fileId);
    if (error) throw error;

    showToast("Đã xóa vĩnh viễn", "File đã bị xóa hoàn toàn khỏi hệ thống.");
    if (currentFolderId) await loadFilesInFolder(currentFolderId);
    if (searchDataLoaded) await loadSearchData();
    await loadMyFileCount();
    await loadLeaderboard();
  } catch (error) {
    showToast("Không xóa được", error.message);
  }
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

  // PDF/ảnh trình duyệt tự xem được -> mở thẳng
  // Word/Excel/PowerPoint trình duyệt KHÔNG tự xem được -> nhờ Google Docs Viewer hiển thị hộ
  const officeExtensions = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"];
  const finalUrl = officeExtensions.includes(extension)
    ? `https://docs.google.com/gview?url=${encodeURIComponent(data.signedUrl)}&embedded=true`
    : data.signedUrl;

  if (targetWindow) targetWindow.location.href = finalUrl;
  else window.open(finalUrl, "_blank");
}

async function renameFile(fileId, row) {
  const oldName = row.children[0].textContent;
  const newName = prompt("Nhập tên mới cho file:", oldName);
  if (!newName || newName.trim() === "" || newName === oldName) return;

  const { error } = await supabaseClient
    .from("file")
    .update({ file_name: newName.trim(), updated_at: new Date().toISOString() })
    .eq("id", fileId);

  if (error) {
    showToast("Không đổi tên được", error.message);
    return;
  }

  await logHistory(fileId, "Đã sửa");
  showToast("Đã đổi tên file", "");
  if (currentFolderId) await loadFilesInFolder(currentFolderId);
}

// ---------- CHUYỂN FOLDER CHO FILE (chọn từ danh sách, không gõ tay) ----------
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

  const { error } = await supabaseClient
    .from("file")
    .update({ id_folder: newFolderId, updated_at: new Date().toISOString() })
    .eq("id", movingFileId);

  if (error) {
    showToast("Không chuyển được folder", error.message);
    return;
  }

  await logHistory(movingFileId, "Đã sửa");
  showToast("Đã chuyển folder", "");
  closeMoveFolderModal();
  if (currentFolderId) await loadFilesInFolder(currentFolderId);
});

// ---------- THÊM FOLDER MỚI (User cũng làm được, không riêng Admin) ----------
document.getElementById("showAddFolderBtn").addEventListener("click", () => {
  const card = document.getElementById("addFolderCard");
  card.hidden = !card.hidden;
});

document.getElementById("addFolderForm").addEventListener("submit", handleAddFolder);

async function handleAddFolder(event) {
  event.preventDefault();
  const submitBtn = document.getElementById("addFolderSubmitBtn");
  const displayName = document.getElementById("newFolderName").value.trim();
  if (!displayName) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Đang tạo...";

  try {
    const bucketName = slugify(displayName);
    if (!bucketName) throw new Error("Tên folder không hợp lệ, vui lòng nhập tên khác.");

    const { data: bucketResult, error: bucketError } = await supabaseClient.functions.invoke("create-bucket", {
      body: { bucketName },
    });
    if (bucketError) throw bucketError;
    if (bucketResult?.error) throw new Error(bucketResult.error);

    const { error } = await supabaseClient
      .from("folder")
      .insert({ display_name: displayName, bucket_name: bucketName, created_by: currentUser.id });
    if (error) throw error;

    showToast("Đã tạo folder", `"${displayName}" đã sẵn sàng để upload.`);
    document.getElementById("addFolderForm").reset();
    document.getElementById("addFolderCard").hidden = true;
    await loadFolders();
  } catch (error) {
    showToast("Không tạo được folder", error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Tạo folder";
  }
}

// Chuyển tên tiếng Việt có dấu -> dạng "slug" hợp lệ để đặt tên bucket
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

async function toggleFileStatus(fileId, currentStatus) {
  const newStatus = !currentStatus;
  const confirmMsg = newStatus
    ? "Hiện lại file này? Mọi user khác sẽ thấy được trong folder."
    : "Ẩn file này? Chỉ mình bạn còn thấy được (Admin vẫn thấy), có thể hiện lại bất kỳ lúc nào.";
  if (!confirm(confirmMsg)) return;

  const { error } = await supabaseClient.from("file").update({ status: newStatus }).eq("id", fileId);

  if (error) {
    showToast("Không cập nhật được", error.message);
    return;
  }

  await logHistory(fileId, newStatus ? "Đã sửa" : "Đã xóa");
  showToast(newStatus ? "Đã hiện lại file" : "Đã ẩn file", "");
  if (currentFolderId) await loadFilesInFolder(currentFolderId);
}

async function logHistory(fileId, change) {
  await supabaseClient.from("history_file").insert({
    id_file: fileId,
    id_user: currentUser.id,
    change,
  });
}

// ==========================================================================
// TAB: UPLOAD
// ==========================================================================

document.getElementById("uploadForm").addEventListener("submit", handleUpload);

// Đổ danh sách folder vào ô select ngay khi có dữ liệu folder (gọi lại sau loadFolders)
const originalLoadFolders = loadFolders;
loadFolders = async function () {
  await originalLoadFolders();
  const select = document.getElementById("uploadFolder");
  const roots = folderList.filter((f) => !f.parent_id);
  select.innerHTML =
    `<option value="">-- Chọn folder --</option>` +
    roots.map((f) => `<option value="${f.id}">${escapeHTML(f.display_name)}</option>`).join("");
  document.getElementById("uploadSubfolderWrap").hidden = true;
};

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
    const fileInput = document.getElementById("uploadFile");
    const rawFile = fileInput.files[0];
    const bio = document.getElementById("uploadBio").value.trim();
    let displayName = document.getElementById("uploadName").value.trim() || rawFile.name;

    if (!folder) throw new Error("Vui lòng chọn folder.");
    if (!rawFile) throw new Error("Vui lòng chọn file để tải lên.");

    // Kiểm tra trùng tên: chỉ chặn nếu trùng với file của CHÍNH MÌNH trong CÙNG folder
    displayName = await resolveDuplicateName(displayName, folderId);

    // Tên file lưu trong Storage tách biệt với tên hiển thị, tránh trùng/ký tự lạ
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
      .insert({
        file_name: displayName,
        storage_path: storagePath,
        id_folder: folderId,
        id_user: currentUser.id,
        bio,
      })
      .select()
      .single();
    if (insertError) throw insertError;

    await logHistory(newFile.id, "Đã thêm");

    showToast("Tải lên thành công", `File "${displayName}" đã được lưu.`);
    document.getElementById("uploadForm").reset();
    document.getElementById("uploadSubfolderWrap").hidden = true;
    searchDataLoaded = false; // để lần sau vào tab Tìm kiếm sẽ tải lại danh sách mới
    await loadMyFileCount();
    await loadLeaderboard();
  } catch (error) {
    showToast("Tải lên thất bại", error.message || "Vui lòng thử lại.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "⬆ Tải lên";
  }
}

// Nếu trùng tên với file của chính user này trong cùng folder -> tự thêm hậu tố (1), (2)...
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
// TAB: TÌM KIẾM (live search, lọc phía client giống bảng dữ liệu thông thường)
// ==========================================================================

document.getElementById("searchInput").addEventListener("input", renderSearchResults);

async function loadSearchData() {
  const { data, error } = await supabaseClient
    .from("file")
    .select(
      "id, file_name, storage_path, id_user, status, user:id_user(user_name), folder:id_folder(display_name, parent:parent_id(display_name))"
    )
    .order("created_at", { ascending: false });

  if (error) {
    showToast("Không tải được dữ liệu tìm kiếm", error.message);
    return;
  }

  // Chỉ hiện: file đang hoạt động, HOẶC file của chính mình dù đang bị ẩn
  allSearchableFiles = (data || []).filter((f) => f.status || f.id_user === currentUser.id);
  searchDataLoaded = true;
  renderSearchResults();
}

// Hiện đường dẫn folder dạng "Cha / Con" nếu là folder con, chỉ tên nếu là folder gốc
function formatFolderPath(file) {
  const subName = file.folder?.display_name || "-";
  const parentName = file.folder?.parent?.display_name;
  return parentName ? `${parentName} / ${subName}` : subName;
}

function renderSearchResults() {
  const rawKeyword = document.getElementById("searchInput").value.trim().toLowerCase();
  let results;

  if (rawKeyword.includes("/")) {
    // Cú pháp đặc biệt "Tên folder cha/Tên folder con" -> tìm chính xác đúng cặp cha-con
    const [parentPart, subPart] = rawKeyword.split("/").map((s) => s.trim());
    results = allSearchableFiles.filter((file) => {
      const parentName = (file.folder?.parent?.display_name || "").toLowerCase();
      const subName = (file.folder?.display_name || "").toLowerCase();
      return parentName.includes(parentPart) && subName.includes(subPart || "");
    });
  } else {
    // Tìm thường: theo tên file, tên người upload, HOẶC tên folder (cả folder gốc lẫn folder con,
    // gõ tên folder cha sẽ ra luôn file nằm trong các folder con của nó)
    results = allSearchableFiles.filter((file) => {
      const subName = file.folder?.display_name || "";
      const parentName = file.folder?.parent?.display_name || "";
      const haystack = `${file.id} ${file.file_name} ${file.user?.user_name || ""} ${subName} ${parentName}`.toLowerCase();
      return haystack.includes(rawKeyword);
    });
  }

  document.getElementById("searchResultCount").textContent = results.length;
  document.getElementById("searchEmptyState").hidden = results.length > 0;
  document.querySelector("#searchPage .table-scroll").hidden = results.length === 0;

  const body = document.getElementById("searchResultBody");
  body.innerHTML = results
    .map((file) => {
      const isOwner = file.id_user === currentUser.id;
      const statusBadge = file.status
        ? `<span class="status active">Hoạt động</span>`
        : `<span class="status inactive">Đã ẩn</span>`;
      return /* html */ `
      <tr data-file-id="${file.id}" data-storage-path="${escapeAttr(file.storage_path)}">
        <td>${escapeHTML(file.file_name)}</td>
        <td>${escapeHTML(formatFolderPath(file))}</td>
        <td>${escapeHTML(file.user?.user_name || "-")}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="actions">
            <button class="action-btn" data-view-file title="Xem">👁</button>
            <button class="action-btn" data-download-file title="Tải về">⬇</button>
            ${isOwner
          ? `<button class="action-btn" data-toggle-status="${file.status}" title="${file.status ? "Ẩn file" : "Hiện lại file"}">${file.status ? "🚫" : "↺"}</button>`
          : ""}
            ${isOwner ? `<button class="action-btn delete" data-delete-file title="Xóa vĩnh viễn">⌫</button>` : ""}
          </div>
        </td>
      </tr>`;
    })
    .join("");

  attachFileRowEvents(body);
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

    if (!newName && !newPassword) {
      throw new Error("Bạn chưa nhập gì để cập nhật.");
    }
    if (newPassword && newPassword !== confirmPassword) {
      throw new Error("Mật khẩu mới nhập lại không khớp.");
    }
    if (newPassword && newPassword.length < 6) {
      throw new Error("Mật khẩu mới cần tối thiểu 6 ký tự.");
    }

    // Xác thực lại bằng mật khẩu HIỆN TẠI trước khi cho đổi bất cứ thứ gì
    const { error: reauthError } = await supabaseClient.auth.signInWithPassword({
      email: currentUser.email,
      password: currentPassword,
    });
    if (reauthError) throw new Error("Mật khẩu hiện tại không đúng.");

    if (newName) {
      const { error } = await supabaseClient.from("user").update({ user_name: newName }).eq("id", currentUser.id);
      if (error) throw error;
      currentUser.name = newName;
      elUserNameLabel.textContent = currentUser.name;
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