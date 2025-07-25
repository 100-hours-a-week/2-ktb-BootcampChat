import React, { useState, useEffect } from "react";
import {
  PdfIcon as FileText,
  ImageIcon as Image,
  MovieIcon as Film,
  SoundOnIcon as Music,
  OpenFileIcon as ExternalLink,
  DownloadIcon as Download,
  ErrorCircleIcon as AlertCircle,
} from "@vapor-ui/icons";
import { Button, Text, Callout } from "@vapor-ui/core";
import PersistentAvatar from "../../common/PersistentAvatar";
import MessageContent from "./MessageContent";
import MessageActions from "./MessageActions";
import ReadStatus from "../ReadStatus";
import fileService from "../../../services/fileService";
import authService from "../../../services/authService";

const FileMessage = ({
  msg = {},
  isMine = false,
  currentUser = null,
  onReactionAdd,
  onReactionRemove,
  room = null,
  messageRef,
  socketRef,
}) => {
  const [error, setError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    if (msg?.file) {
      const url = fileService.getPreviewUrl(msg.file, true);
      setPreviewUrl(url);
      console.debug("Preview URL generated:", {
        filename: msg.file.filename,
        url,
      });
    }
  }, [msg?.file]);

  if (!msg?.file) {
    console.error("File data is missing:", msg);
    return null;
  }

  const formattedTime = new Date(msg.timestamp)
    .toLocaleString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(/\./g, "년")
    .replace(/\s/g, " ")
    .replace("일 ", "일 ");

  const getFileIcon = () => {
    const mimetype = msg.file?.mimetype || "";
    const iconProps = { className: "w-5 h-5 flex-shrink-0" };

    if (mimetype.startsWith("image/"))
      return <Image {...iconProps} color="#00C853" />;
    if (mimetype.startsWith("video/"))
      return <Film {...iconProps} color="#2196F3" />;
    if (mimetype.startsWith("audio/"))
      return <Music {...iconProps} color="#9C27B0" />;
    return <FileText {...iconProps} color="#ffffff" />;
  };

  const getDecodedFilename = (encodedFilename) => {
    try {
      if (!encodedFilename) return "Unknown File";

      const base64 = encodedFilename.replace(/-/g, "+").replace(/_/g, "/");

      const pad = base64.length % 4;
      const paddedBase64 = pad ? base64 + "=".repeat(4 - pad) : base64;

      if (paddedBase64.match(/^[A-Za-z0-9+/=]+$/)) {
        return Buffer.from(paddedBase64, "base64").toString("utf8");
      }

      return decodeURIComponent(encodedFilename);
    } catch (error) {
      console.error("Filename decoding error:", error);
      return encodedFilename;
    }
  };

  const renderAvatar = () => (
    <PersistentAvatar
      user={isMine ? currentUser : msg.sender}
      size="md"
      className="flex-shrink-0"
      showInitials={true}
    />
  );

  const handleFileDownload = async (e) => {
    e.preventDefault();
    setError(null);

    try {
      const url = await fileService.getResolvedFileUrl(
        msg.file.filename,
        false
      );

      const link = document.createElement("a");
      link.href = url;
      link.download = getDecodedFilename(msg.file.originalname);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      setError("파일 다운로드에 실패했습니다.");
    }
  };

  const handleViewInNewTab = async (e) => {
    e.preventDefault();
    setError(null);

    try {
      const url = await fileService.getResolvedFileUrl(msg.file.filename, true);
      const newWindow = window.open(url, "_blank");
      if (!newWindow) throw new Error("팝업 차단됨");
    } catch (err) {
      setError("파일 미리보기에 실패했습니다.");
    }
  };

  const renderImagePreview = (originalname) => {
    const [resolvedUrl, setResolvedUrl] = useState("");

    useEffect(() => {
      const fetchPreviewUrl = async () => {
        try {
          const url = await fileService.getResolvedFileUrl(
            msg.file.filename,
            true
          );
          setResolvedUrl(url);
        } catch (err) {
          setError("미리보기 이미지를 불러올 수 없습니다.");
        }
      };
      fetchPreviewUrl();
    }, [msg.file?.filename]);

    if (!resolvedUrl) {
      return (
        <div className="flex items-center justify-center h-full bg-gray-100">
          <Image className="w-8 h-8 text-gray-400" />
        </div>
      );
    }

    return (
      <div className="bg-transparent-pattern">
        <img
          src={resolvedUrl}
          alt={originalname}
          className="object-cover rounded-sm"
          onError={(e) => {
            console.error("Image load error", e);
            setError("이미지를 불러올 수 없습니다.");
          }}
          loading="lazy"
        />
      </div>
    );
  };

  const renderFilePreview = () => {
    const mimetype = msg.file?.mimetype || "";
    const originalname = getDecodedFilename(
      msg.file?.originalname || "Unknown File"
    );
    const size = fileService.formatFileSize(msg.file?.size || 0);

    const FileActions = () => (
      <div className="file-actions mt-2 pt-2 border-t border-gray-200">
        <Button
          size="sm"
          variant="outline"
          onClick={handleViewInNewTab}
          title="새 탭에서 보기"
        >
          <ExternalLink size={16} />
          <span>새 탭에서 보기</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleFileDownload}
          title="다운로드"
        >
          <Download size={16} />
          <span>다운로드</span>
        </Button>
      </div>
    );

    const previewWrapperClass = "overflow-hidden";
    const fileInfoClass = "flex items-center gap-3 p-1 mt-2";

    if (mimetype.startsWith("image/")) {
      return (
        <div className={previewWrapperClass}>
          {renderImagePreview(originalname)}
          <div className={fileInfoClass}>
            <div className="flex-1 min-w-0">
              <Text typography="body2" className="font-medium truncate">
                {getFileIcon()} {originalname}
              </Text>
              <span className="text-sm text-muted">{size}</span>
            </div>
          </div>
          <FileActions />
        </div>
      );
    }

    if (mimetype.startsWith("video/")) {
      return (
        <div className={previewWrapperClass}>
          <div>
            {previewUrl ? (
              <video
                className="object-cover rounded-sm"
                controls
                preload="metadata"
                aria-label={`${originalname} 비디오`}
                crossOrigin="use-credentials"
              >
                <source src={previewUrl} type={mimetype} />
                <track kind="captions" />
                비디오를 재생할 수 없습니다.
              </video>
            ) : (
              <div className="flex items-center justify-center h-full">
                <Film className="w-8 h-8 text-gray-400" />
              </div>
            )}
          </div>
          <div className={fileInfoClass}>
            <div className="flex-1 min-w-0">
              <Text typography="body2" className="font-medium truncate">
                {getFileIcon()} {originalname}
              </Text>
              <span className="text-sm text-muted">{size}</span>
            </div>
          </div>
          <FileActions />
        </div>
      );
    }

    if (mimetype.startsWith("audio/")) {
      return (
        <div className={previewWrapperClass}>
          <div className={fileInfoClass}>
            <div className="flex-1 min-w-0">
              <Text typography="body2" className="font-medium truncate">
                {getFileIcon()} {originalname}
              </Text>
              <span className="text-sm text-muted">{size}</span>
            </div>
          </div>
          <div className="px-3 pb-3">
            {previewUrl && (
              <audio
                className="w-full"
                controls
                preload="metadata"
                aria-label={`${originalname} 오디오`}
                crossOrigin="use-credentials"
              >
                <source src={previewUrl} type={mimetype} />
                오디오를 재생할 수 없습니다.
              </audio>
            )}
          </div>
          <FileActions />
        </div>
      );
    }

    return (
      <div className={previewWrapperClass}>
        <div className={fileInfoClass}>
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">
              {getFileIcon()} {originalname}
            </div>
            <Text typography="body2" as="span">
              {size}
            </Text>
          </div>
        </div>
        <FileActions />
      </div>
    );
  };

  return (
    <div className="messages">
      <div className={`message-group ${isMine ? "mine" : "yours"}`}>
        <div className="message-sender-info">
          {renderAvatar()}
          <span className="sender-name">
            {isMine ? "나" : msg.sender?.name}
          </span>
        </div>
        <div
          className={`message-bubble ${
            isMine ? "message-mine" : "message-other"
          } last file-message`}
        >
          <div className="message-content">
            {error && (
              <Callout
                color="danger"
                className="mb-3 d-flex align-items-center"
              >
                <AlertCircle className="w-4 h-4 me-2" />
                <span>{error}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ms-auto"
                  aria-label="Close"
                  onClick={() => setError(null)}
                >
                  ×
                </Button>
              </Callout>
            )}
            {renderFilePreview()}
            {msg.content && (
              <div className="mt-3">
                <MessageContent content={msg.content} />
              </div>
            )}
          </div>
          <div className="message-footer">
            <div
              className="message-time mr-3"
              title={new Date(msg.timestamp).toLocaleString("ko-KR")}
            >
              {formattedTime}
            </div>
            <ReadStatus
              messageType={msg.type}
              participants={room.participants}
              readers={msg.readers}
              messageId={msg._id}
              messageRef={messageRef}
              currentUserId={currentUser.id}
              socketRef={socketRef}
            />
          </div>
        </div>
        <MessageActions
          messageId={msg._id}
          messageContent={msg.content}
          reactions={msg.reactions}
          currentUserId={currentUser?.id}
          onReactionAdd={onReactionAdd}
          onReactionRemove={onReactionRemove}
          isMine={isMine}
          room={room}
        />
      </div>
    </div>
  );
};

FileMessage.defaultProps = {
  msg: {
    file: {
      mimetype: "",
      filename: "",
      originalname: "",
      size: 0,
    },
  },
  isMine: false,
  currentUser: null,
};

export default React.memo(FileMessage);
