import React, { useState, useRef, useEffect } from "react";
import { CameraIcon, CloseOutlineIcon } from "@vapor-ui/icons";
import { Button, Text, Callout, IconButton } from "@vapor-ui/core";
import authService from "../services/authService";
import PersistentAvatar from "./common/PersistentAvatar";

const ProfileImageUpload = ({ currentImage, onImageChange }) => {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  // 프로필 이미지 URL 생성
  const getProfileImageUrl = (imagePath) => {
    if (!imagePath) return null;
    return imagePath.startsWith("http")
      ? imagePath
      : `${process.env.NEXT_PUBLIC_API_URL}${imagePath}`;
  };

  // 컴포넌트 마운트 시 이미지 설정
  useEffect(() => {
    const imageUrl = getProfileImageUrl(currentImage);
    setPreviewUrl(imageUrl);
  }, [currentImage]);

  const handleFileSelect = async (e) => {
    console.log("🔥 파일 선택됨");
    const file = e.target.files?.[0];
    if (!file) {
      console.log("⚠️ 파일 없음");
      return;
    }

    try {
      if (!file.type.startsWith("image/")) {
        throw new Error("이미지 파일만 업로드할 수 있습니다.");
      }
      if (file.size > 5 * 1024 * 1024) {
        throw new Error("파일 크기는 5MB를 초과할 수 없습니다.");
      }

      setUploading(true);
      setError("");

      const user = authService.getCurrentUser();
      if (!user?.token) throw new Error("인증 정보가 없습니다.");

      // 1. Presigned URL 요청
      const query = new URLSearchParams({
        filename: file.name,
        contentType: file.type,
      });

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/files/presign-upload?${query}`,
        {
          method: "GET",
          headers: {
            "x-auth-token": user.token,
            "x-session-id": user.sessionId,
          },
        }
      );

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || "presigned URL 요청 실패");
      }

      const { uploadUrl, key } = await res.json();

      // 2. 파일을 presigned URL로 PUT
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": file.type,
        },
        body: file,
      });

      if (!uploadRes.ok) {
        throw new Error("파일 업로드 실패");
      }

      // 3. 메타데이터 전송: 프로필 등록용
      const metadataRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/files/complete-upload`,
        {
          method: "POST",
          headers: {
            "x-auth-token": user.token,
            "x-session-id": user.sessionId,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            key,
            originalName: file.name,
            size: file.size,
            mimetype: file.type,
          }),
        }
      );

      if (!metadataRes.ok) {
        const errorData = await metadataRes.json();
        throw new Error(errorData.message || "서버에 메타데이터 전송 실패");
      }

      const { file: fileData } = await metadataRes.json();

      // 이미지 URL로 반영
      const newImageUrl = fileData.url;

      setPreviewUrl(newImageUrl);
      onImageChange(newImageUrl);

      const updatedUser = {
        ...user,
        profileImage: newImageUrl,
      };
      localStorage.setItem("user", JSON.stringify(updatedUser));
      window.dispatchEvent(new Event("userProfileUpdate"));
    } catch (error) {
      console.error("이미지 업로드 오류:", error);
      setError(error.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleRemoveImage = async () => {
    try {
      setUploading(true);
      setError("");

      const user = authService.getCurrentUser();
      if (!user?.token) {
        throw new Error("인증 정보가 없습니다.");
      }

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/users/profile-image`,
        {
          method: "DELETE",
          headers: {
            "x-auth-token": user.token,
            "x-session-id": user.sessionId,
          },
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "이미지 삭제에 실패했습니다.");
      }

      // 로컬 스토리지의 사용자 정보 업데이트
      const updatedUser = {
        ...user,
        profileImage: "",
      };
      localStorage.setItem("user", JSON.stringify(updatedUser));

      // 기존 objectUrl 정리
      if (previewUrl && previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }

      setPreviewUrl(null);
      onImageChange("");

      // 전역 이벤트 발생
      window.dispatchEvent(new Event("userProfileUpdate"));
    } catch (error) {
      console.error("Image removal error:", error);
      setError(error.message);
    } finally {
      setUploading(false);
    }
  };

  // 컴포넌트 언마운트 시 cleanup
  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  // 현재 사용자 정보
  const currentUser = authService.getCurrentUser();

  return (
    <div>
      <div>
        <PersistentAvatar
          user={currentUser}
          size="xl"
          className="mx-auto mb-2"
          showInitials={true}
        />

        <div className="mt-2">
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            size="sm"
          >
            <CameraIcon size={16} />
            <span style={{ marginLeft: "8px" }}>이미지 변경</span>
          </Button>

          {previewUrl && (
            <IconButton
              variant="outline"
              color="danger"
              onClick={handleRemoveImage}
              disabled={uploading}
              style={{ marginLeft: "8px" }}
            >
              <CloseOutlineIcon size={16} />
            </IconButton>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="image/*"
        onChange={handleFileSelect}
      />

      {error && (
        <div className="w-full max-w-sm mx-auto">
          <Callout color="danger" className="mt-2">
            {error}
          </Callout>
        </div>
      )}

      {uploading && (
        <Text
          typography="body3"
          color="neutral-weak"
          className="text-center mt-2"
        >
          이미지 업로드 중...
        </Text>
      )}
    </div>
  );
};

export default ProfileImageUpload;
